import { writeFileSync } from "node:fs";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { EVM_CHAINS, type EvmNetwork } from "../../src/lib/evm/networks";
import { MAINNET_CHAIN_ID, parseTrainingProfiles } from "../../scripts/deploy-policy";
import {
  addTrainingProfileCall, assertBound, assertCanBind, bindEscrowCall, ESCROW_VERSIONS, expectedProfiles, isProfileSupported,
  profileHashes, readBinding, registryAdminAbi, SAFE_BATCH_END, SAFE_BATCH_START, safeTransactionBatch, DATASET_REGISTRY_VERSION,
  type AdminCall, type BindingReader,
} from "./dataset-binding";

/**
 * Transactions de l'admin du registre de datasets v5, préparées et vérifiées en lecture seule.
 * Ce script ne détient aucune clé et n'envoie rien : il imprime un lot que le Safe signe.
 *
 *   SIRIUS_DEPLOY_NETWORK=mainnet SIRIUS_DATASET_ADDRESS=0x… SIRIUS_ESCROW_ADDRESS=0x… \
 *   SIRIUS_DATASET_ADMIN=0x<Safe> [SIRIUS_DATASET_TRAINING_PROFILES=gradient_boosted_trees] \
 *   pnpm contracts:dataset-admin <prepare-bind | prepare-profiles | verify>
 *
 * prepare-bind     : contrôle REP-12 (registre non lié, escrow pointant vers ce registre, même KYB,
 *                    versions), puis lot `bindEscrow` + profils manquants.
 * prepare-profiles : lot `addTrainingProfile` pour les seuls profils facultatifs connus et absents.
 * verify           : après exécution par le Safe, `datasets.escrow() == escrow`, `escrow.datasets()
 *                    == datasets`, admin attendu, tous les profils attendus acceptés.
 *
 * `SIRIUS_SAFE_BATCH_FILE=<chemin>` écrit aussi le lot dans ce fichier.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function requireAddress(variable: string): Address {
  const value = process.env[variable]?.trim();
  if (!value || !ADDRESS.test(value) || /^0x0{40}$/i.test(value)) throw new Error(`${variable} doit être une adresse EVM non nulle`);
  return value as Address;
}

function printBatch(chainId: number, safe: Address, name: string, calls: AdminCall[]): void {
  const batch = JSON.stringify(safeTransactionBatch(chainId, safe, name, calls), null, 2);
  console.log("");
  console.log(`Transactions à signer par l'admin ${safe} (rien n'a été envoyé) :`);
  calls.forEach((entry, index) => console.log(`  ${index + 1}. ${entry.description}\n     to=${entry.to} value=0 data=${entry.data}`));
  console.log(SAFE_BATCH_START);
  console.log(batch);
  console.log(SAFE_BATCH_END);
  const file = process.env.SIRIUS_SAFE_BATCH_FILE?.trim();
  if (file) {
    writeFileSync(file, `${batch}\n`, { mode: 0o600 });
    console.log(`lot écrit     : ${file}`);
  }
}

async function main() {
  const command = process.argv[2];
  if (command !== "prepare-bind" && command !== "prepare-profiles" && command !== "verify") {
    throw new Error("Commande attendue : prepare-bind, prepare-profiles ou verify");
  }
  const network = (process.env.SIRIUS_DEPLOY_NETWORK ?? "testnet") as EvmNetwork;
  const chain = EVM_CHAINS[network];
  if (!chain) throw new Error(`Réseau inconnu : ${network} (attendu testnet ou mainnet)`);
  const client = createPublicClient({ chain, transport: http(process.env.EVM_RPC_URL || chain.rpcUrls.default.http[0]) });
  const rpcChainId = await client.getChainId();
  if (rpcChainId !== chain.id) throw new Error(`Le RPC répond chainId ${rpcChainId}, ${chain.id} attendu pour ${network}`);
  const reader = client as unknown as BindingReader;

  const datasets = requireAddress("SIRIUS_DATASET_ADDRESS");
  const admin = requireAddress("SIRIUS_DATASET_ADMIN");
  const profiles = profileHashes(parseTrainingProfiles(process.env.SIRIUS_DATASET_TRAINING_PROFILES));
  const escrowVersion = chain.id === MAINNET_CHAIN_ID ? ESCROW_VERSIONS.SiriusEscrowV7 : undefined;
  console.log(`réseau        : ${network} (chainId ${chain.id})`);
  console.log(`registre      : ${datasets}`);
  console.log(`admin attendu : ${admin}`);

  const missing = async () => {
    const result = [];
    for (const profile of profiles) if (!await isProfileSupported(reader, datasets, profile.hash)) result.push(profile);
    return result;
  };

  if (command === "prepare-profiles") {
    const version = await reader.readContract({ address: datasets, abi: registryAdminAbi, functionName: "VERSION" });
    if (version !== DATASET_REGISTRY_VERSION) throw new Error(`Registre de datasets en ${String(version)}, ${DATASET_REGISTRY_VERSION} attendu`);
    const onChainAdmin = await reader.readContract({ address: datasets, abi: registryAdminAbi, functionName: "admin" }) as Address;
    if (onChainAdmin.toLowerCase() !== admin.toLowerCase()) throw new Error(`L'admin du registre est ${onChainAdmin}, pas l'admin attendu ${admin}`);
    if (profiles.length === 0) throw new Error("SIRIUS_DATASET_TRAINING_PROFILES vide : aucun profil à ajouter");
    const toAdd = await missing();
    if (toAdd.length === 0) {
      console.log("Tous les profils demandés sont déjà acceptés : rien à signer.");
      return;
    }
    printBatch(chain.id, admin, "Sirius : profils d'entraînement", toAdd.map((profile) => addTrainingProfileCall(datasets, profile)));
    return;
  }

  const escrow = requireAddress("SIRIUS_ESCROW_ADDRESS");
  console.log(`escrow        : ${escrow}`);
  const state = await readBinding(reader, datasets, escrow);

  if (command === "prepare-bind") {
    assertCanBind(state, { admin, escrowVersion });
    const calls = [bindEscrowCall(datasets, escrow), ...(await missing()).map((profile) => addTrainingProfileCall(datasets, profile))];
    console.log(`contrôles     : registre ${state.registryVersion} non lié, escrow ${state.escrowVersion} pointant vers ce registre, même KYB ${state.registryKyb}`);
    printBatch(chain.id, admin, "Sirius : liaison du registre de datasets", calls);
    console.log("");
    console.log("Après exécution par le Safe : relancer avec la commande verify avant toute mise en service.");
    return;
  }

  assertBound(state, { admin, escrowVersion });
  for (const id of expectedProfiles(profiles.map(({ id }) => id))) {
    const [profile] = profileHashes([id]);
    if (!await isProfileSupported(reader, datasets, profile.hash as Hex)) throw new Error(`Le registre n'accepte pas encore le profil ${id}`);
  }
  console.log(`vérifié       : registre lié à ${escrow}, escrow lié à ${datasets}, admin ${state.admin}, profils ${expectedProfiles(profiles.map(({ id }) => id)).join(", ")}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
