import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, formatEther, http, keccak256, type Abi, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EVM_CHAINS, type EvmNetwork } from "../../src/lib/evm/networks";

/**
 * Déploie les contrats Sirius sur Robinhood Chain.
 *
 *   ROBINHOOD_DEPLOYER_KEY=0x... pnpm contracts:deploy:testnet
 *
 * Écrit en viem pur plutôt qu'avec les aides de `hardhat-viem`, pour deux raisons.
 * D'abord `hardhat-viem` ne connaît que les chaînes livrées dans `viem/chains`, et
 * Robinhood Chain n'en fait pas partie. Ensuite il appelle `getTransaction`
 * immédiatement après l'envoi : sur cette chaîne le RPC public n'a pas encore
 * indexé la transaction à cet instant, et le déploiement échoue alors qu'il a
 * parfaitement réussi on-chain. On attend donc le reçu, avec des tentatives.
 *
 * Les définitions de chaîne viennent de `src/lib/evm/networks.ts`, la même source
 * que l'application, pour qu'elles ne puissent pas diverger.
 */

const ARTIFACTS = resolve(__dirname, "..", "artifacts", "src");

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const path = resolve(ARTIFACTS, `${name}.sol`, `${name}.json`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { abi: Abi; bytecode: Hex };
  if (!parsed.bytecode || parsed.bytecode === "0x") {
    throw new Error(`Bytecode absent pour ${name} — lance d'abord \`pnpm contracts:compile\``);
  }
  return parsed;
}

/**
 * Résout un rôle de gouvernance, en refusant qu'il retombe silencieusement sur la clé
 * de déploiement. `SIRIUS_ALLOW_SHARED_ROLES=true` autorise le raccourci pour un
 * déploiement jetable, mais il faut alors l'avoir voulu explicitement.
 */
function requireRole(variable: string, deployer: Hex): Hex {
  const configured = process.env[variable]?.trim();
  if (configured) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(configured)) {
      throw new Error(`${variable} n'est pas une adresse EVM valide`);
    }
    return configured as Hex;
  }
  if (process.env.SIRIUS_ALLOW_SHARED_ROLES === "true") return deployer;
  throw new Error(
    `${variable} manquante. Ce rôle ne doit pas revenir à la clé de déploiement : ` +
      "celle-ci ne paie que le gas et finit souvent partagée, alors que ce rôle gouverne " +
      "le registre KYB. Fournis une adresse dédiée, ou SIRIUS_ALLOW_SHARED_ROLES=true " +
      "pour un déploiement jetable assumé.",
  );
}

function requireAddress(variable: string): Hex {
  const configured = process.env[variable]?.trim();
  if (!configured || !/^0x[0-9a-fA-F]{40}$/.test(configured)) {
    throw new Error(`${variable} doit être une adresse EVM valide`);
  }
  return configured as Hex;
}

function requireCodeHash(variable: string): Hex {
  const configured = process.env[variable]?.trim();
  if (!configured || !/^0x[0-9a-fA-F]{64}$/.test(configured)) {
    throw new Error(`${variable} doit être le keccak256 du bytecode USDC`);
  }
  return configured as Hex;
}

function targetNetwork(): { network: EvmNetwork; chain: Chain } {
  const requested = (process.env.SIRIUS_DEPLOY_NETWORK ?? "testnet") as EvmNetwork;
  const chain = EVM_CHAINS[requested];
  if (!chain) throw new Error(`Réseau inconnu : ${requested} (attendu testnet ou mainnet)`);
  return { network: requested, chain };
}

async function main() {
  const { network, chain } = targetNetwork();

  // Garde-fou mainnet. Le projet est volontairement sur testnet : rien n'y coûte
  // d'argent réel, on peut redéployer librement, et aucun audit externe n'est
  // requis pour poser un contrat. Un déploiement mainnet est une décision
  // distincte, qui suppose au minimum la séparation de domaine du préimage
  // d'escrow (voir l'avertissement en tête de SiriusEscrow.sol).
  if (chain.id === 4663 && process.env.SIRIUS_ALLOW_MAINNET !== "true") {
    throw new Error(
      "Déploiement mainnet bloqué. Le projet cible le testnet 46630. " +
        "Pour passer outre en connaissance de cause : SIRIUS_ALLOW_MAINNET=true",
    );
  }

  const key = process.env.ROBINHOOD_DEPLOYER_KEY?.trim();
  if (!key) throw new Error("ROBINHOOD_DEPLOYER_KEY manquante");
  const account = privateKeyToAccount(key as Hex);

  const transport = http(process.env.EVM_RPC_URL || chain.rpcUrls.default.http[0]);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`réseau        : ${network} (chainId ${chain.id})`);
  console.log(`déployeur     : ${account.address}`);
  console.log(`solde         : ${formatEther(balance)} ETH`);

  if (balance === 0n) {
    throw new Error(
      "Solde nul. Alimente le compte en ETH NATIF via https://faucet.testnet.chain.robinhood.com " +
        "(attention : LINK ne paie pas le gas)",
    );
  }

  // Les rôles ne retombent plus sur le déployeur par défaut. La clé de déploiement ne
  // sert qu'à payer le gas et finit souvent partagée — dans un journal de CI, un
  // transcript, un canal d'équipe. Lui donner l'administration du registre KYB signifie
  // que quiconque la lit peut émettre de fausses attestations d'entreprise vérifiée.
  //
  // Admin et vérificateur sont également séparés l'un de l'autre : l'un décide QUI peut
  // attester, l'autre atteste. Les confondre supprime le contre-pouvoir.
  const admin = requireRole("SIRIUS_KYB_ADMIN", account.address);
  const verifier = requireRole("SIRIUS_KYB_VERIFIER", account.address);
  const usdc = requireAddress("SIRIUS_USDC_ADDRESS");
  const expectedUsdcCodeHash = requireCodeHash("SIRIUS_USDC_CODE_HASH");
  if (admin.toLowerCase() === verifier.toLowerCase()) {
    throw new Error(
      "SIRIUS_KYB_ADMIN et SIRIUS_KYB_VERIFIER doivent être deux adresses distinctes. " +
        "Pour un déploiement jetable, SIRIUS_ALLOW_SHARED_ROLES=true.",
    );
  }

  const usdcCode = await publicClient.getBytecode({ address: usdc });
  if (!usdcCode || usdcCode === "0x") throw new Error("SIRIUS_USDC_ADDRESS ne contient aucun contrat");
  const usdcCodeHash = keccak256(usdcCode);
  if (usdcCodeHash.toLowerCase() !== expectedUsdcCodeHash.toLowerCase()) {
    throw new Error(`Code hash USDC inattendu : ${usdcCodeHash}`);
  }

  const deployed: Record<string, Hex> = {};
  let totalGas = 0n;

  async function deploy(name: string, args: unknown[] = []): Promise<Hex> {
    const { abi, bytecode } = artifact(name);
    const hash = await walletClient.deployContract({ abi, bytecode, args, chain, account });

    // `waitForTransactionReceipt` retente tant que le RPC n'a pas indexé la
    // transaction, au lieu d'abandonner au premier « not found ».
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
      retryCount: 20,
      retryDelay: 1_500,
      timeout: 120_000,
    });
    if (receipt.status !== "success" || !receipt.contractAddress) {
      throw new Error(`Déploiement de ${name} rejeté (tx ${hash})`);
    }

    totalGas += receipt.gasUsed;
    deployed[name] = receipt.contractAddress;
    console.log(
      `${name.padEnd(22)} ${receipt.contractAddress}  (${receipt.gasUsed.toLocaleString("fr-FR")} gas)`,
    );
    return receipt.contractAddress;
  }

  console.log("");
  const kyb = await deploy("SiriusKybRegistry", [admin, verifier]);
  const escrow = await deploy("SiriusEscrow", [usdc, kyb]);
  const datasets = await deploy("SiriusDatasetRegistry", [kyb]);

  console.log("");
  console.log(`gas total     : ${totalGas.toLocaleString("fr-FR")}`);
  console.log(`admin KYB     : ${admin}`);
  console.log(`vérificateur  : ${verifier}`);

  // Contrôle de bon sens : chaque contrat répond et part d'un état vierge.
  const escrowAbi = artifact("SiriusEscrow").abi;
  const kybAbi = artifact("SiriusKybRegistry").abi;
  const datasetAbi = artifact("SiriusDatasetRegistry").abi;

  const accounting = (await publicClient.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "accounting",
  })) as readonly [bigint, bigint, bigint, bigint];
  if (accounting.some((value) => value !== 0n)) {
    throw new Error("SiriusEscrow fraîchement déployé n'est pas dans un état vierge");
  }
  const escrowUsdc = (await publicClient.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "usdc",
  })) as Hex;
  if (escrowUsdc.toLowerCase() !== usdc.toLowerCase()) {
    throw new Error("SiriusEscrow ne référence pas le contrat USDC configuré");
  }
  const escrowKyb = (await publicClient.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "kyb",
  })) as Hex;
  if (escrowKyb.toLowerCase() !== kyb.toLowerCase()) {
    throw new Error("SiriusEscrow ne référence pas le registre KYB déployé");
  }

  const verifierRegistered = await publicClient.readContract({
    address: kyb,
    abi: kybAbi,
    functionName: "isVerifier",
    args: [verifier],
  });
  if (!verifierRegistered) throw new Error("Le premier vérificateur KYB n'a pas été enregistré");

  const linkedKyb = (await publicClient.readContract({
    address: datasets,
    abi: datasetAbi,
    functionName: "kyb",
  })) as Hex;
  if (linkedKyb.toLowerCase() !== kyb.toLowerCase()) {
    throw new Error("Le registre dataset ne pointe pas sur le registre KYB déployé");
  }

  const explorer = chain.blockExplorers?.default.url;
  console.log("");
  console.log("À reporter dans .env.local :");
  console.log(`NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS="${escrow}"`);
  console.log(`NEXT_PUBLIC_SIRIUS_USDC_ADDRESS="${usdc}"`);
  console.log(`NEXT_PUBLIC_SIRIUS_KYB_ADDRESS="${kyb}"`);
  console.log(`NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS="${datasets}"`);
  console.log(`SIRIUS_ESCROW_ADDRESS="${escrow}"`);
  console.log(`SIRIUS_USDC_ADDRESS="${usdc}"`);
  console.log(`SIRIUS_KYB_ADDRESS="${kyb}"`);
  console.log(`SIRIUS_DATASET_ADDRESS="${datasets}"`);
  if (explorer) {
    console.log("");
    console.log("Explorateur :");
    for (const [name, address] of [
      ["SiriusEscrow", escrow],
      ["SiriusKybRegistry", kyb],
      ["SiriusDatasetRegistry", datasets],
    ] as const) {
      console.log(`  ${name.padEnd(22)} ${explorer}/address/${address}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
