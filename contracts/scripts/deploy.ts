import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, formatEther, http, keccak256, type Abi, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EVM_CHAINS, USDC_DECIMALS_BY_NETWORK, type EvmNetwork } from "../../src/lib/evm/networks";
import { selectionForModelId, trainingProfileHash } from "../../src/lib/models/registry";
import { deploymentPlan } from "../../scripts/deploy-policy";
import { estimateDeploymentGas, type EstimateClient } from "./deploy-estimate";
import {
  addTrainingProfileCall, assertBound, assertCanBind, bindEscrowCall, ESCROW_VERSIONS, expectedProfiles, profileHashes, readBinding,
  SAFE_BATCH_END, SAFE_BATCH_START, safeTransactionBatch, type BindingReader,
} from "./dataset-binding";

/**
 * Déploie les contrats Sirius sur Robinhood Chain.
 *
 *   ROBINHOOD_DEPLOYER_KEY=0x... pnpm contracts:deploy:testnet
 *
 * Admin du registre de datasets (immuable, audit REP-11) :
 * - mainnet : `SIRIUS_DATASET_ADMIN` obligatoire, le Safe de gouvernance (= `SIRIUS_KYB_ADMIN`),
 *   vérifié comme contrat. Le script déploie registre et escrow, vérifie `admin() == Safe` et que
 *   l'escrow pointe vers ce registre, puis S'ARRÊTE : il imprime le lot `bindEscrow` +
 *   `addTrainingProfile` que le Safe signe. Contrôle avant et après : `contracts:dataset-admin`.
 * - testnet : la clé de déploiement par défaut, qui envoie elle-même liaison et profils, contrôlés
 *   avant et après. Avec `SIRIUS_DATASET_ADMIN` distinct, même déroulé que mainnet.
 *
 * Registre v6 : `SIRIUS_PREVIOUS_DATASET_REGISTRY` (facultatif) désigne le registre v5 dont le
 * Safe pourra importer les titres (`importTitles`). Il est vérifié (code, version v5) avant tout
 * envoi ; immuable une fois le registre déployé.
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
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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
  const key = process.env.ROBINHOOD_DEPLOYER_KEY?.trim();
  if (!key) throw new Error("ROBINHOOD_DEPLOYER_KEY manquante");
  const account = privateKeyToAccount(key as Hex);

  // Toutes les règles hors réseau d'abord : sur mainnet, v7 explicite, KYB strict, aucun
  // rôle partagé, quatre adresses distinctes et l'USDC natif. Voir scripts/deploy-policy.ts.
  const plan = deploymentPlan(process.env, chain.id, account.address);
  const { billingVersion, escrowContract } = plan;

  const transport = http(process.env.EVM_RPC_URL || chain.rpcUrls.default.http[0]);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });
  // Les règles ci-dessus dépendent du réseau demandé : le RPC doit être ce réseau-là, y compris
  // pour une exécution à blanc (qui n'envoie rien, donc que viem ne contrôlerait pas).
  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== chain.id) throw new Error(`Le RPC répond chainId ${rpcChainId}, ${chain.id} attendu pour ${network}`);
  const reader = publicClient as unknown as BindingReader;
  const datasetAdmin = plan.datasetAdmin as Hex;

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`réseau        : ${network} (chainId ${chain.id})`);
  console.log(`déployeur     : ${account.address}`);
  console.log(`solde         : ${formatEther(balance)} ETH`);
  console.log(plan.datasetAdminIsDeployer
    ? `admin registre: ${account.address} (clé de déploiement, choix testnet explicite : immuable, pas pour mainnet)`
    : `admin registre: ${datasetAdmin} (immuable ; liaison et profils préparés pour cet admin, non envoyés)`);

  if (balance === 0n && plan.dryRun) {
    console.log("solde nul     : accepté pour une exécution à blanc, refusé pour un vrai déploiement");
  } else if (balance === 0n) {
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
  // Mode ouvert : l'escrow et le registre de datasets reçoivent un registre qui
  // valide tout le monde, au lieu du registre gouverné. Leur source ne change pas —
  // seul l'argument de construction diffère — et revenir au KYB réel consistera à
  // les redéployer sans cette variable.
  const kybOuvert = plan.kybOpen;

  const admin = kybOuvert ? account.address : requireRole("SIRIUS_KYB_ADMIN", account.address);
  const verifier = kybOuvert ? account.address : requireRole("SIRIUS_KYB_VERIFIER", account.address);
  const usdc = requireAddress("SIRIUS_USDC_ADDRESS");
  const lockAuthorizer = requireAddress("SIRIUS_LOCK_AUTHORIZER");
  if (lockAuthorizer === "0x0000000000000000000000000000000000000000") throw new Error("SIRIUS_LOCK_AUTHORIZER ne peut pas être nulle");
  const expectedUsdcCodeHash = requireCodeHash("SIRIUS_USDC_CODE_HASH");
  if (!kybOuvert && admin.toLowerCase() === verifier.toLowerCase()) {
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

  // Contrôle de précision. Le hash du bytecode prouve qu'on parle au bon contrat ;
  // il ne dit pas comment ce contrat compte. Plusieurs jetons nommés « USDC »
  // coexistent sur les réseaux de test, certains à 6 décimales et d'autres à 18.
  //
  // Une divergence ici ne casse rien visiblement : elle décale tous les montants
  // d'un facteur de puissance de dix. Un emprunteur qui saisit 100 USDC verrouille
  // alors une poussière, le prêt se règle normalement, et le fournisseur est payé
  // en presque rien. Aucune exception n'est levée nulle part.
  const onChainDecimals = await publicClient.readContract({
    address: usdc,
    abi: [
      {
        type: "function",
        name: "decimals",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint8" }],
      },
    ] as const,
    functionName: "decimals",
  });
  const expectedDecimals = USDC_DECIMALS_BY_NETWORK[network];
  if (Number(onChainDecimals) !== expectedDecimals) {
    throw new Error(
      `Précision USDC incohérente sur ${network} : le contrat ${usdc} expose ` +
        `${onChainDecimals} décimales, l'application en attend ${expectedDecimals}. ` +
        "Corrige USDC_DECIMALS_BY_NETWORK dans src/lib/evm/networks.ts, ou pointe " +
        "SIRIUS_USDC_ADDRESS sur le bon contrat. Ne déploie pas avec cet écart : " +
        "il rendrait tous les prêts gratuits sans lever d'erreur.",
    );
  }
  console.log(`USDC          : ${usdc} (${expectedDecimals} décimales)`);

  // Sur mainnet, l'admin KYB et l'admin du registre sont le Safe : une adresse sans code serait une clé seule.
  for (const governed of plan.mustBeContracts) {
    const code = await publicClient.getBytecode({ address: governed as Hex });
    if (!code || code === "0x") throw new Error(`L'admin ${governed} (KYB et registre de datasets) doit être un contrat (Safe), pas une clé`);
  }

  // Réutilisation d'un registre KYB : son mode doit être celui demandé, avant toute transaction.
  if (plan.existingKyb) {
    const existing = plan.existingKyb as Hex;
    const code = await publicClient.getBytecode({ address: existing });
    if (!code || code === "0x") throw new Error("SIRIUS_KYB_EXISTING_ADDRESS ne contient aucun contrat");
    const kybName = kybOuvert ? "SiriusOpenKybRegistry" : "SiriusKybRegistry";
    const acceptsAnyone = await publicClient.readContract({
      address: existing, abi: artifact(kybName).abi, functionName: "isKybValid",
      args: ["0x000000000000000000000000000000000000dEaD"],
    });
    if (acceptsAnyone !== kybOuvert) throw new Error("Le registre KYB existant n'est pas dans le mode demandé (SIRIUS_KYB_MODE)");
    if (!kybOuvert) {
      const version = await publicClient.readContract({ address: existing, abi: artifact(kybName).abi, functionName: "VERSION" });
      if (version !== "sirius-kyb-v3") throw new Error("Le registre KYB existant n'est pas en v3");
    }
    console.log(`KYB réutilisé : ${existing} (${kybOuvert ? "ouvert" : "strict v3"})`);
  }
  const addedProfiles = profileHashes(plan.trainingProfiles);

  // Registre v6 : registre précédent dont les titres pourront être importés, vérifié avant tout envoi.
  const previousRegistryInput = process.env.SIRIUS_PREVIOUS_DATASET_REGISTRY?.trim();
  if (previousRegistryInput && !/^0x[0-9a-fA-F]{40}$/.test(previousRegistryInput)) {
    throw new Error("SIRIUS_PREVIOUS_DATASET_REGISTRY n'est pas une adresse EVM valide");
  }
  const previousRegistry = (previousRegistryInput || ZERO_ADDRESS) as Hex;
  if (previousRegistry !== ZERO_ADDRESS) {
    const code = await publicClient.getBytecode({ address: previousRegistry });
    if (!code || code === "0x") throw new Error("SIRIUS_PREVIOUS_DATASET_REGISTRY ne contient aucun contrat");
    const version = await publicClient.readContract({
      address: previousRegistry, abi: artifact("SiriusDatasetRegistry").abi, functionName: "VERSION",
    });
    if (version !== "sirius-dataset-v5") throw new Error(`Registre précédent en ${String(version)}, sirius-dataset-v5 attendu`);
  }
  console.log(previousRegistry === ZERO_ADDRESS
    ? "registre préc.: aucun (pas d'import de titres possible avec ce registre)"
    : `registre préc.: ${previousRegistry} (titres importables par l'admin)`);

  if (plan.dryRun) {
    if (!plan.estimateDatasets) {
      throw new Error("SIRIUS_DEPLOY_ESTIMATE_DATASETS requis en simulation : registre de datasets déjà déployé servant de référence à l'estimation de l'escrow");
    }
    const gasPrice = await publicClient.getGasPrice();
    const kybName = kybOuvert ? "SiriusOpenKybRegistry" : "SiriusKybRegistry";
    const estimates = await estimateDeploymentGas(publicClient as unknown as EstimateClient, {
      account: account.address, artifact,
      kyb: plan.existingKyb ? { existing: plan.existingKyb as Hex } : { deploy: kybName, args: kybOuvert ? [] : [admin, verifier] },
      referenceDatasets: plan.estimateDatasets as Hex, escrowContract, usdc, lockAuthorizer,
      addedProfiles: addedProfiles.map(({ id }) => id),
      datasetAdmin, adminCallsByDeployer: plan.datasetAdminIsDeployer, previousRegistry,
    });
    const total = estimates.reduce((sum, [, gas]) => sum + gas, 0n);
    console.log("");
    console.log("Exécution à blanc : toutes les vérifications sont passées, aucune transaction envoyée.");
    for (const [name, gas] of estimates) console.log(`  ${name.padEnd(42)} ${gas.toLocaleString("fr-FR")} gas`);
    console.log(`gas estimé    : ${total.toLocaleString("fr-FR")} à ${gasPrice} wei, soit ${formatEther(total * gasPrice)} ETH (solde ${formatEther(balance)} ETH)`);
    console.log(`signataire    : ${lockAuthorizer}`);
    if (!kybOuvert && !plan.existingKyb) console.log(`admin KYB     : ${admin}\nvérificateur  : ${verifier}`);
    if (!plan.datasetAdminIsDeployer) console.log(`bindEscrow et profils : payés et signés par ${datasetAdmin}, hors de ce total`);
    if (total * gasPrice * 3n > balance) throw new Error("Solde insuffisant pour trois fois le gas estimé : alimenter le compte avant le déploiement");
    return;
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
  const kyb = plan.existingKyb
    ? plan.existingKyb as Hex
    : kybOuvert
      ? await deploy("SiriusOpenKybRegistry")
      : await deploy("SiriusKybRegistry", [admin, verifier]);
  // L'admin du registre est immuable : il lie l'escrow une seule fois et peut ensuite ajouter des
  // profils, jamais en retirer (audit REP-11). Mainnet : le Safe passé dans SIRIUS_DATASET_ADMIN,
  // jamais la clé de déploiement. Testnet : la clé de déploiement, sauf SIRIUS_DATASET_ADMIN.
  const datasets = await deploy("SiriusDatasetRegistry", [kyb, datasetAdmin, previousRegistry]);
  const deployedAdmin = (await publicClient.readContract({
    address: datasets, abi: artifact("SiriusDatasetRegistry").abi, functionName: "admin",
  })) as Hex;
  if (deployedAdmin.toLowerCase() !== datasetAdmin.toLowerCase()) {
    throw new Error(`L'admin du registre déployé est ${deployedAdmin}, pas ${datasetAdmin} : ne pas utiliser ce registre`);
  }
  const escrow = await deploy(escrowContract, [usdc, kyb, datasets, lockAuthorizer]);
  // REP-12 : `bindEscrow` ne vérifie pas que l'escrow pointe vers ce registre et ne s'annule pas.
  // On le vérifie avant d'envoyer ou de faire signer quoi que ce soit.
  const escrowVersion = ESCROW_VERSIONS[escrowContract];
  assertCanBind(await readBinding(reader, datasets, escrow), { admin: datasetAdmin, escrowVersion });

  const adminCalls = [bindEscrowCall(datasets, escrow), ...addedProfiles.map((profile) => addTrainingProfileCall(datasets, profile))];
  if (plan.datasetAdminIsDeployer) {
    // Testnet, admin = clé de déploiement : elle envoie elle-même la liaison puis les profils.
    for (const call of adminCalls) {
      const hash = await walletClient.sendTransaction({ to: call.to, data: call.data, value: 0n, account, chain });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status !== "success") throw new Error(`${call.description} rejetée (tx ${hash})`);
      totalGas += receipt.gasUsed;
      console.log(`${call.description} (${receipt.gasUsed.toLocaleString("fr-FR")} gas, tx ${hash})`);
    }
  }

  console.log("");
  console.log(`gas total     : ${totalGas.toLocaleString("fr-FR")}`);
  if (kybOuvert) {
    console.log("registre KYB  : OUVERT — toute adresse est valide, sans vérification");
  } else {
    console.log(`admin KYB     : ${admin}`);
    console.log(`vérificateur  : ${verifier}`);
  }

  // Contrôle de bon sens : chaque contrat répond et part d'un état vierge.
  const escrowAbi = artifact(escrowContract).abi;
  const deployedAuthorizer = await publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "lockAuthorizer" }) as Hex;
  if (deployedAuthorizer.toLowerCase() !== lockAuthorizer.toLowerCase()) throw new Error("Signataire de lock incorrect");
  const kybAbi = artifact(kybOuvert ? "SiriusOpenKybRegistry" : "SiriusKybRegistry").abi;
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
  const escrowDatasets = (await publicClient.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "datasets",
  })) as Hex;
  if (escrowDatasets.toLowerCase() !== datasets.toLowerCase()) {
    throw new Error("SiriusEscrow ne référence pas le registre dataset déployé");
  }

  if (kybOuvert) {
    // Le contrôle utile ici est l'inverse du contrôle habituel : on vérifie que le
    // registre laisse effectivement passer, y compris une adresse qui n'a jamais rien
    // signé. Un faux négatif bloquerait tous les emprunts sans message clair.
    const passeSansAttestation = await publicClient.readContract({
      address: kyb,
      abi: kybAbi,
      functionName: "isKybValid",
      args: ["0x000000000000000000000000000000000000dEaD"],
    });
    if (!passeSansAttestation) throw new Error("Le registre ouvert refuse une adresse — il ne remplit pas son rôle");
  } else {
    const verifierRegistered = await publicClient.readContract({
      address: kyb,
      abi: kybAbi,
      functionName: "isVerifier",
      args: [verifier],
    });
    if (!verifierRegistered) throw new Error("Le premier vérificateur KYB n'a pas été enregistré");
  }

  const linkedKyb = (await publicClient.readContract({
    address: datasets,
    abi: datasetAbi,
    functionName: "kyb",
  })) as Hex;
  if (linkedKyb.toLowerCase() !== kyb.toLowerCase()) {
    throw new Error("Le registre dataset ne pointe pas sur le registre KYB déployé");
  }
  // Après déploiement : l'admin est celui demandé, et la liaison est faite dans les deux sens
  // (testnet) ou pas du tout, en attente du Safe (mainnet).
  const binding = await readBinding(reader, datasets, escrow);
  if (plan.datasetAdminIsDeployer) {
    assertBound(binding, { admin: datasetAdmin, escrowVersion });
  } else {
    assertCanBind(binding, { admin: datasetAdmin, escrowVersion });
  }
  // Linéaire et logistique dès la construction, puis les profils ajoutés (s'ils l'ont été ici) :
  // tous acceptés au mint.
  for (const id of expectedProfiles(plan.datasetAdminIsDeployer ? plan.trainingProfiles : [])) {
    const supported = await publicClient.readContract({
      address: datasets, abi: datasetAbi, functionName: "isSupportedTrainingProfile", args: [trainingProfileHash(selectionForModelId(id))],
    });
    if (!supported) throw new Error(`Le registre dataset n'accepte pas le profil ${id}`);
  }

  const explorer = chain.blockExplorers?.default.url;
  console.log("");
  console.log("À reporter dans .env.local :");
  console.log(`SIRIUS_BILLING_VERSION="${billingVersion}"`);
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
      [escrowContract, escrow],
      [kybOuvert ? "SiriusOpenKybRegistry" : "SiriusKybRegistry", kyb],
      ["SiriusDatasetRegistry", datasets],
    ] as const) {
      console.log(`  ${name.padEnd(22)} ${explorer}/address/${address}`);
    }
  }

  if (!plan.datasetAdminIsDeployer) {
    // Rien n'est lié : l'escrow refuse tout verrouillage tant que `datasets.escrow() != escrow`
    // (SiriusEscrowV7.sol, DatasetEscrowMismatch), donc cette attente est sans risque.
    console.log("");
    console.log(`LIAISON EN ATTENTE : l'admin ${datasetAdmin} doit signer, dans cet ordre (rien n'a été envoyé) :`);
    adminCalls.forEach((call, index) => console.log(`  ${index + 1}. ${call.description}\n     to=${call.to} value=0 data=${call.data}`));
    console.log(SAFE_BATCH_START);
    console.log(JSON.stringify(safeTransactionBatch(chain.id, datasetAdmin, "Sirius : liaison du registre de datasets", adminCalls), null, 2));
    console.log(SAFE_BATCH_END);
    console.log("Avant de signer, recontrôler : pnpm contracts:dataset-admin prepare-bind (mêmes adresses).");
    console.log("Après exécution, et avant toute mise en service : pnpm contracts:dataset-admin verify.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
