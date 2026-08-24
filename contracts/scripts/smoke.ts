import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EVM_CHAINS } from "../../src/lib/evm/networks";
import { hashlockOf, loanKeyFor } from "../../src/lib/evm/loan-key";

/**
 * Smoke test sur la chaîne réelle : déroule un fair-exchange complet contre les
 * contrats déployés, avec un vrai préimage, de vraies transactions et de vrais frais.
 *
 * Ce que les 49 tests Hardhat ne peuvent pas prouver : que le comportement tient
 * sur Robinhood Chain elle-même — séquenceur FCFS, finalité molle, précompilé
 * sha256 de cette implémentation d'ArbOS.
 *
 *   ROBINHOOD_DEPLOYER_KEY=0x... \
 *   NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS=0x... \
 *   NEXT_PUBLIC_SIRIUS_KYB_ADDRESS=0x... \
 *   NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS=0x... \
 *   pnpm contracts:smoke
 */

const ARTIFACTS = resolve(__dirname, "..", "artifacts", "src");
const abiOf = (name: string): Abi =>
  (JSON.parse(readFileSync(resolve(ARTIFACTS, `${name}.sol`, `${name}.json`), "utf8")) as { abi: Abi }).abi;

function required(name: string): Hex {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} manquante`);
  return value as Hex;
}

async function main() {
  const chain = EVM_CHAINS.testnet;
  const transport = http(process.env.EVM_RPC_URL || chain.rpcUrls.default.http[0]);

  const account = privateKeyToAccount(required("ROBINHOOD_DEPLOYER_KEY"));
  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });

  const escrow = required("NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS");
  const kyb = required("NEXT_PUBLIC_SIRIUS_KYB_ADDRESS");
  const datasets = required("NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS");

  const escrowAbi = abiOf("SiriusEscrow");
  const kybAbi = abiOf("SiriusKybRegistry");
  const datasetAbi = abiOf("SiriusDatasetRegistry");

  // Le provider ne dépensera jamais de gas : `withdrawFor` est permissionless,
  // donc une adresse jamais financée peut malgré tout être payée.
  const provider = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`).address;

  const before = await publicClient.getBalance({ address: account.address });
  console.log(`chaîne    : ${chain.name} (${chain.id})`);
  console.log(`opérateur : ${account.address}`);
  console.log(`provider  : ${provider} (jamais financé)`);
  console.log(`solde     : ${formatEther(before)} ETH`);
  console.log("");

  const step = async (label: string, hash: Hex) => {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
      retryCount: 20,
      retryDelay: 1_500,
      timeout: 120_000,
    });
    if (receipt.status !== "success") throw new Error(`${label} : transaction rejetée (${hash})`);
    console.log(`✓ ${label.padEnd(34)} bloc ${receipt.blockNumber} · ${receipt.gasUsed.toLocaleString("fr-FR")} gas`);
    return receipt;
  };

  async function escrowCycle() {
    // ---- 3. Escrow : le borrower bloque les fonds ---------------------------------
    // Le préimage tel que l'enclave le dérive : 32 octets, hashlock en SHA-256.
    const preimage = randomBytes(32);
    const hashlock = hashlockOf(preimage);
    const loanId = `loan-${randomBytes(6).toString("hex")}`;
    const amount = 2_000_000_000_000n; // 0,000002 ETH, au-dessus du plancher

    await step("Fonds bloqués (lock)", await wallet.writeContract({
      address: escrow, abi: escrowAbi, functionName: "lock",
      args: [provider, hashlock, 7, loanId], value: amount, chain, account,
    }));

    // La clé calculée hors chaîne doit désigner le prêt réellement créé.
    const loanKey = loanKeyFor(account.address, loanId);
    const locked = (await publicClient.readContract({
      address: escrow, abi: escrowAbi, functionName: "getLoan", args: [loanKey],
    })) as { status: number; amount: bigint; hashlock: Hex };
    if (locked.status !== 1) throw new Error("Le prêt n'est pas dans l'état Locked");
    if (locked.amount !== amount || locked.hashlock !== hashlock) {
      throw new Error("Le prêt on-chain ne correspond pas aux termes envoyés");
    }
    console.log(`  loanKey ${loanKey}`);

    // ---- 4. Release : publication du préimage et paiement --------------------------
    const [revealedBefore] = (await publicClient.readContract({
      address: escrow, abi: escrowAbi, functionName: "preimageOf", args: [loanKey],
    })) as readonly [boolean, Hex];
    if (revealedBefore) throw new Error("Le préimage était déjà publié avant le release");

    await step("Préimage publié (release)", await wallet.writeContract({
      address: escrow, abi: escrowAbi, functionName: "release",
      args: [loanKey, `0x${preimage.toString("hex")}` as Hex], chain, account,
    }));

    const [revealed, published] = (await publicClient.readContract({
      address: escrow, abi: escrowAbi, functionName: "preimageOf", args: [loanKey],
    })) as readonly [boolean, Hex];
    if (!revealed) throw new Error("Le préimage n'a pas été publié");
    if (published.toLowerCase() !== `0x${preimage.toString("hex")}`) {
      throw new Error("Le préimage publié diffère de celui du TEE");
    }

    const credit = (await publicClient.readContract({
      address: escrow, abi: escrowAbi, functionName: "creditOf", args: [provider],
    })) as bigint;
    if (credit !== amount) throw new Error("Le provider n'a pas été crédité du montant exact");

    // ---- 5. Retrait par un tiers, pour un provider sans gas ------------------------
    await step("Provider payé (withdrawFor)", await wallet.writeContract({
      address: escrow, abi: escrowAbi, functionName: "withdrawFor",
      args: [provider], chain, account,
    }));

    const providerBalance = await publicClient.getBalance({ address: provider });
    if (providerBalance !== amount) throw new Error("Le provider n'a pas reçu les fonds");

    const spent = before - (await publicClient.getBalance({ address: account.address }));
    console.log("");
    console.log(`préimage on-chain : ${published}`);
    console.log(`provider reçu     : ${formatEther(providerBalance)} ETH`);
    console.log(`coût du cycle     : ${formatEther(spent)} ETH`);
    console.log("");
    console.log(">>> FAIR-EXCHANGE COMPLET VALIDÉ SUR ROBINHOOD CHAIN");
  }

  // Le KYB et la publication d'un titre exigent que l'opérateur soit lui-même
  // vérificateur autorisé. Quand les rôles sont correctement séparés — l'admin et le
  // vérificateur appartenant à quelqu'un d'autre que la clé de déploiement — ce n'est
  // volontairement plus le cas, et la démo se limite au cycle d'escrow.
  const operatorIsVerifier = (await publicClient.readContract({
    address: kyb,
    abi: kybAbi,
    functionName: "isVerifier",
    args: [account.address],
  })) as boolean;

  if (!operatorIsVerifier) {
    console.log("· l'opérateur n'est pas vérificateur KYB : rôles séparés, démo limitée à l'escrow");
    console.log("");
    await escrowCycle();
    return;
  }

  // ---- 1. KYB : le vérificateur signe, le sujet réclame -------------------------
  const expiresAt = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  const nonce = (await publicClient.readContract({
    address: kyb, abi: kybAbi, functionName: "nonces", args: [account.address],
  })) as bigint;

  const kybSignature = await wallet.signTypedData({
    account,
    domain: { name: "SiriusKybRegistry", version: "1", chainId: chain.id, verifyingContract: kyb },
    types: {
      KybAttestation: [
        { name: "subject", type: "address" },
        { name: "verifier", type: "address" },
        { name: "expiresAt", type: "uint40" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "KybAttestation",
    message: { subject: account.address, verifier: account.address, expiresAt, nonce },
  });

  await step("KYB accepté", await wallet.writeContract({
    address: kyb, abi: kybAbi, functionName: "acceptAttestation",
    args: [account.address, expiresAt, kybSignature], chain, account,
  }));

  const kybValid = await publicClient.readContract({
    address: kyb, abi: kybAbi, functionName: "isKybValid", args: [account.address],
  });
  if (!kybValid) throw new Error("KYB invalide après acceptation");

  // ---- 2. Titre du dataset ------------------------------------------------------
  const datasetId = `smoke-${randomBytes(6).toString("hex")}`;
  const merkleRoot = `0x${createHash("sha256").update("racine-merkle-smoke").digest("hex")}` as Hex;
  const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

  await step("Titre du dataset publié", await wallet.writeContract({
    address: datasets, abi: datasetAbi, functionName: "mint",
    args: [datasetId, cid, merkleRoot, 1_250_000n], chain, account,
  }));

  await escrowCycle();

  const spent = before - (await publicClient.getBalance({ address: account.address }));
  console.log("");
  console.log(`préimage on-chain : ${published}`);
  console.log(`provider reçu     : ${formatEther(providerBalance)} ETH`);
  console.log(`coût total        : ${formatEther(spent)} ETH`);
  console.log("");
  console.log(">>> FAIR-EXCHANGE COMPLET VALIDÉ SUR ROBINHOOD CHAIN");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
