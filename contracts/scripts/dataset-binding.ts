import { encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { MODEL_REGISTRY, selectionForModelId, trainingProfileHash, type ModelId } from "../../src/lib/models/registry";

/**
 * Contrôles hors chaîne de la liaison registre de datasets v5 ⇄ escrow, et préparation des
 * transactions de l'admin (audit REP-11, REP-12, REP-13).
 *
 * `bindEscrow` n'accepte qu'une liaison, définitive, et ne vérifie pas que l'escrow pointe vers
 * ce registre : un mauvais contrat lié rend `destroy()` impossible pour toujours. Le contrat v5
 * ne changera pas (il serait à ré-auditer), donc tout passe par ces contrôles, avant que la clé
 * de déploiement (testnet) ou le Safe (mainnet) n'envoie quoi que ce soit, puis après.
 *
 * Aucune fonction de ce module n'envoie de transaction : il lit, compare et encode.
 */

export const DATASET_REGISTRY_VERSION = "sirius-dataset-v6";
/** Versions gérées par ces scripts : la v5 reste en service jusqu'à la migration vers la v6. */
export const DATASET_REGISTRY_VERSIONS: readonly string[] = ["sirius-dataset-v5", DATASET_REGISTRY_VERSION];
export const ESCROW_VERSIONS = {
  SiriusEscrow: "sirius-escrow-usdc-v6",
  SiriusEscrowV7: "sirius-escrow-usdc-v7",
} as const;

export const registryAdminAbi = parseAbi([
  "function VERSION() view returns (string)",
  "function admin() view returns (address)",
  "function kyb() view returns (address)",
  "function escrow() view returns (address)",
  "function isSupportedTrainingProfile(bytes32 profile) view returns (bool)",
  "function bindEscrow(address escrow_)",
  "function addTrainingProfile(bytes32 profile)",
]);

/** Fonctions propres au registre v6 : taille maximale et import des titres du v5. */
export const registryV6AdminAbi = parseAbi([
  "function maxSizeBytes() view returns (uint64)",
  "function MAX_SIZE_CEILING() view returns (uint64)",
  "function MAX_IMPORT_BATCH() view returns (uint256)",
  "function previousRegistry() view returns (address)",
  "function setMaxSizeBytes(uint64 maxSizeBytes_)",
  "function importTitles(bytes32[] ids)",
  "function getDataset(bytes32 id) view returns ((address provider, uint40 mintedAt, uint40 destroyedAt, uint64 sizeBytes, bytes32 merkleRoot, bytes32 cidHash, bytes32 trainingProfile))",
]);

export function setMaxSizeBytesCall(datasets: Address, maxSizeBytes: bigint): AdminCall {
  return {
    to: datasets, value: "0",
    data: encodeFunctionData({ abi: registryV6AdminAbi, functionName: "setMaxSizeBytes", args: [maxSizeBytes] }),
    description: `SiriusDatasetRegistry(${datasets}).setMaxSizeBytes(${maxSizeBytes}) — taille maximale au mint`,
  };
}

export function importTitlesCall(datasets: Address, ids: readonly Hex[]): AdminCall {
  return {
    to: datasets, value: "0",
    data: encodeFunctionData({ abi: registryV6AdminAbi, functionName: "importTitles", args: [ids] }),
    description: `SiriusDatasetRegistry(${datasets}).importTitles([${ids.length} titre(s)]) — ${ids.join(", ")}`,
  };
}
const escrowLinkAbi = parseAbi([
  "function VERSION() view returns (string)",
  "function datasets() view returns (address)",
  "function kyb() view returns (address)",
]);

/** Sous-ensemble d'un client public viem : lecture seule. */
export interface BindingReader {
  getBytecode(args: { address: Address }): Promise<Hex | undefined>;
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
}

export interface BindingState {
  datasets: Address;
  escrow: Address;
  registryVersion: string;
  admin: Address;
  registryKyb: Address;
  /** Escrow déjà lié au registre, ou l'adresse nulle. */
  boundEscrow: Address;
  escrowVersion: string;
  escrowDatasets: Address;
  escrowKyb: Address;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function requireCode(client: BindingReader, address: Address, label: string): Promise<void> {
  const code = await client.getBytecode({ address });
  if (!code || code === "0x") throw new Error(`${label} ${address} ne contient aucun contrat`);
}

async function call<T>(client: BindingReader, address: Address, abi: readonly unknown[], functionName: string, label: string): Promise<T> {
  try {
    return await client.readContract({ address, abi, functionName }) as T;
  } catch {
    throw new Error(`${label} ${address} ne répond pas à ${functionName}() : ce n'est pas le contrat attendu`);
  }
}

/** Lit l'état de la liaison des deux côtés, sans rien supposer. */
export async function readBinding(client: BindingReader, datasets: Address, escrow: Address): Promise<BindingState> {
  await requireCode(client, datasets, "Registre de datasets");
  await requireCode(client, escrow, "Escrow");
  const registry = (name: string) => call<string>(client, datasets, registryAdminAbi, name, "Registre de datasets");
  const escrowRead = (name: string) => call<string>(client, escrow, escrowLinkAbi, name, "Escrow");
  return {
    datasets,
    escrow,
    registryVersion: await registry("VERSION"),
    admin: await registry("admin") as Address,
    registryKyb: await registry("kyb") as Address,
    boundEscrow: await registry("escrow") as Address,
    escrowVersion: await escrowRead("VERSION"),
    escrowDatasets: await escrowRead("datasets") as Address,
    escrowKyb: await escrowRead("kyb") as Address,
  };
}

function assertPair(state: BindingState, expectedAdmin: Address, expectedEscrowVersion?: string): void {
  if (!DATASET_REGISTRY_VERSIONS.includes(state.registryVersion)) {
    throw new Error(`Registre de datasets en ${state.registryVersion}, ${DATASET_REGISTRY_VERSIONS.join(" ou ")} attendu`);
  }
  const known = Object.values(ESCROW_VERSIONS) as string[];
  if (!known.includes(state.escrowVersion) || (expectedEscrowVersion && state.escrowVersion !== expectedEscrowVersion)) {
    throw new Error(`Escrow en ${state.escrowVersion}, ${expectedEscrowVersion ?? known.join(" ou ")} attendu`);
  }
  if (!same(state.admin, expectedAdmin)) {
    throw new Error(`L'admin du registre est ${state.admin}, pas l'admin attendu ${expectedAdmin}`);
  }
  // REP-12 : le contrat ne le vérifie pas, donc on le vérifie ici. Un escrow qui pointe vers un
  // autre registre ne pourrait jamais verrouiller (DatasetEscrowMismatch), et la liaison est définitive.
  if (!same(state.escrowDatasets, state.datasets)) {
    throw new Error(`L'escrow ${state.escrow} pointe vers le registre ${state.escrowDatasets}, pas vers ${state.datasets} : liaison refusée`);
  }
  if (!same(state.escrowKyb, state.registryKyb)) {
    throw new Error(`L'escrow ${state.escrow} et le registre ${state.datasets} ne partagent pas le même registre KYB`);
  }
}

/**
 * Avant `bindEscrow` : refuse un double bind (même vers le bon escrow, la transaction échouerait) et
 * un bind vers un contrat qui ne pointe pas vers ce registre.
 */
export function assertCanBind(state: BindingState, expected: { admin: Address; escrowVersion?: string }): void {
  if (!same(state.boundEscrow, zeroAddress)) {
    throw new Error(same(state.boundEscrow, state.escrow)
      ? `Le registre ${state.datasets} est déjà lié à l'escrow ${state.escrow} : aucun second bindEscrow`
      : `Le registre ${state.datasets} est déjà lié, définitivement, à un autre contrat (${state.boundEscrow}) : refus de lier ${state.escrow}`);
  }
  assertPair(state, expected.admin, expected.escrowVersion);
}

/** Après la liaison : `datasets.escrow() == escrow` et `escrow.datasets() == datasets`. */
export function assertBound(state: BindingState, expected: { admin: Address; escrowVersion?: string }): void {
  if (!same(state.boundEscrow, state.escrow)) {
    throw new Error(same(state.boundEscrow, zeroAddress)
      ? `Le registre ${state.datasets} n'est encore lié à aucun escrow`
      : `Le registre ${state.datasets} est lié à ${state.boundEscrow}, pas à l'escrow attendu ${state.escrow}`);
  }
  assertPair(state, expected.admin, expected.escrowVersion);
}

/** Empreintes recalculées depuis MODEL_REGISTRY : jamais un hash saisi à la main (REP-13). */
export function profileHashes(ids: readonly ModelId[]): { id: ModelId; hash: Hex }[] {
  return ids.map((id) => {
    if (!Object.hasOwn(MODEL_REGISTRY, id)) throw new Error(`Profil inconnu : ${id}`);
    return { id, hash: trainingProfileHash(selectionForModelId(id)) };
  });
}

export async function isProfileSupported(client: BindingReader, datasets: Address, hash: Hex): Promise<boolean> {
  return await client.readContract({
    address: datasets, abi: registryAdminAbi, functionName: "isSupportedTrainingProfile", args: [hash],
  }) as boolean;
}

/** Profils de base (linéaire, logistique) plus les profils facultatifs demandés. */
export function expectedProfiles(optIn: readonly ModelId[]): ModelId[] {
  return (Object.keys(MODEL_REGISTRY) as ModelId[]).filter((id) => !MODEL_REGISTRY[id].optIn || optIn.includes(id));
}

export interface AdminCall {
  to: Address;
  value: "0";
  data: Hex;
  /** Lisible par un signataire du Safe : quelle fonction, quels arguments. */
  description: string;
}

export function bindEscrowCall(datasets: Address, escrow: Address): AdminCall {
  return {
    to: datasets, value: "0",
    data: encodeFunctionData({ abi: registryAdminAbi, functionName: "bindEscrow", args: [escrow] }),
    description: `SiriusDatasetRegistry(${datasets}).bindEscrow(${escrow})`,
  };
}

export function addTrainingProfileCall(datasets: Address, profile: { id: ModelId; hash: Hex }): AdminCall {
  return {
    to: datasets, value: "0",
    data: encodeFunctionData({ abi: registryAdminAbi, functionName: "addTrainingProfile", args: [profile.hash] }),
    description: `SiriusDatasetRegistry(${datasets}).addTrainingProfile(${profile.hash}) — ${profile.id}`,
  };
}

/**
 * Lot au format JSON du Transaction Builder de Safe{Wallet} (import « Drag and drop »). Si
 * l'interface Safe ne gère pas la chaîne, chaque transaction se saisit à la main : `to`, `value`
 * nul et `data`, à recopier tels quels.
 */
export function safeTransactionBatch(chainId: number, safe: Address, name: string, calls: readonly AdminCall[]) {
  return {
    version: "1.0",
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: { name, description: calls.map((entry) => entry.description).join(" ; "), createdFromSafeAddress: safe },
    transactions: calls.map(({ to, value, data }) => ({ to, value, data, contractMethod: null, contractInputsValues: null })),
  };
}

export const SAFE_BATCH_START = "--- lot Safe (JSON Transaction Builder) ---";
export const SAFE_BATCH_END = "--- fin du lot Safe ---";
