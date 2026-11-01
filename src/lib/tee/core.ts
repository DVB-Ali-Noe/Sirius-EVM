import "server-only";
import { createHash } from "node:crypto";
import {
  decrypt,
  encrypt,
  generateKey,
  wrapKey,
  unwrapKey,
  deriveKey,
  getMasterKey,
  type EncryptedPayload,
} from "@/lib/crypto/encryption";
import { buildMerkleTree, verifyRoot, DEFAULT_CHUNK_SIZE } from "@/lib/crypto/merkle";
import { computeMetrics, CsvValidationError, type DatasetMetrics } from "@/lib/sirius/metrics";
import { fetchFromIpfs, uploadToIpfs } from "@/lib/ipfs/pinata";
import { trainSelectedModel } from "./model-registry";
import { DatasetValidationError, trainingTimeoutMs, validateTrainingDataset, type TrainedModel } from "./train";
import { gateModel } from "./output-gate";
import { decryptDatasetIngress } from "./ingress";
import { evmEscrowBinding } from "./evm-binding";
import { canonicalSubject } from "@/lib/subject";
import { AppError } from "@/lib/app-error";
import { budgetRunnerJob } from "@/lib/runner/budget";
import { countsAsRunnerFailure } from "@/lib/runner/failure-policy";
import { INVALID_DATASET_MESSAGE, TrainingLimitExceeded, trainInWorker } from "./bounded-training";
import type { ComputeQuote } from "@/lib/billing/quote";
import { quoteWorkflow, requireBillingBudget } from "@/lib/billing/runner";
import { MAX_DATASET_BYTES, modelRefString } from "./contract";
import type {
  DatasetIngressEnvelope,
  DatasetRef,
  SelfTrainingInput,
  LoanJobInput,
  ModelRef,
  SealDatasetResult,
  EvmEscrowLock,
} from "./contract";
import type { ModelSelection } from "@/lib/models/registry";
import { loadServedModel, saveServedModel, servedModelFingerprint } from "./served-models";

/**
 * Cœur confidentiel, sans accès à la base applicative : seul module qui touche la master key enclave,
 * le plaintext des datasets, les DEK et le fulfillment. Prend des inputs explicites → sera
 * exposé tel quel par le service runner isolé (inc.3d-B). Le Next l'appelle (in-process au
 * MVP, via HTTP en CVM) mais ne voit jamais ces secrets.
 */

// Contextes de dérivation (couplés à la master key enclave, versionnés pour rotation), tous
// privés : aucun n'est exposé à une primitive de dérivation à contexte libre (cf audit B.2).
// Les modèles entraînés restent scellés dans le runner (served-models.ts) : aucune clé de
// modèle n'existe hors de l'enclave.
const datasetKeyContext = (datasetId: string) => `wrap:dataset:v1:${datasetId}`;

/**
 * Contexte du préimage EVM.
 *
 * 1. Il inclut le **chainId et l'adresse du contrat**. Sans eux, le même couple
 *    (borrower, loanId) produit le même secret sur deux déploiements ou deux
 *    chaînes — et le préimage publié sur la chaîne bon marché réglerait le prêt
 *    homonyme de l'autre. Ces deux valeurs viennent de la configuration du runner,
 *    jamais de l'appelant.
 *
 * 2. Le `borrower` est **normalisé en minuscules**. Une adresse EVM s'écrit en
 *    casse mixte ; deux écritures du même compte donneraient deux préimages, donc
 *    deux hashlocks pour un même prêt.
 *
 * 3. La concaténation est **non ambiguë** : `chainId` est un entier, `escrow` et
 *    `borrower` sont des adresses de longueur fixe validées, et le seul champ de
 *    longueur libre — `loanId` — est en dernière position. Aucun découpage
 *    alternatif ne peut donc produire la même chaîne.
 */
function evmSubject(borrower: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(borrower)) throw new AppError("Adresse borrower invalide", 400);
  return borrower.toLowerCase();
}

const evmEscrowKeyContext = (loanId: string, borrower: string) => {
  const { chainId, escrow } = evmEscrowBinding();
  return `escrow:v2:${chainId}:${escrow}:${evmSubject(borrower)}:${loanId}`;
};

/**
 * Scelle un dataset (upload provider) : Merkle + métriques sur le plaintext → DEK aléatoire →
 * AES-256-GCM → IPFS. La DEK est renvoyée UNIQUEMENT wrappée (destructible, crypto-shredding).
 */
export async function sealDataset(datasetId: string, content: Buffer, metrics = computeMetrics(content)): Promise<SealDatasetResult> {
  const tree = buildMerkleTree(content);
  const dek = generateKey();
  const payload = encrypt(content, dek);
  // Wrap avant l'upload : si la clé enclave manque, on échoue sans pinner un blob orphelin.
  const wrappedKey = wrapKey(dek, datasetKeyContext(datasetId));
  const { cid } = await uploadToIpfs(Buffer.from(JSON.stringify(payload)), `${datasetId}.enc`);
  return { cid, wrappedKey, merkleRoot: tree.root, metrics, sizeBytes: content.length };
}

export async function sealDatasetEnvelope(
  datasetId: string,
  envelope: DatasetIngressEnvelope,
  expectedSizeBytes: number,
  model: ModelSelection,
): Promise<SealDatasetResult> {
  const content = decryptDatasetIngress(datasetId, envelope);
  if (content.length !== expectedSizeBytes) {
    throw new AppError("La taille du fichier ne correspond pas au dépôt", 400);
  }
  // Seul endroit où un motif de validation devient public : celui qui lit la réponse est
  // celui qui vient de déposer le fichier. Le même contrôle pendant un entraînement reste
  // opaque, sinon l'emprunteur apprendrait la forme d'une donnée qu'il n'a pas le droit de
  // voir. Tout ce qui n'est pas imputable au fichier continue de remonter tel quel, et
  // `errorResponse` s'en charge — une erreur technique peut porter un préimage ou un jeton.
  let metrics: DatasetMetrics;
  try {
    metrics = validateTrainingDataset(content, model);
  } catch (error) {
    if (error instanceof DatasetValidationError || error instanceof CsvValidationError) throw new AppError(error.message, 400);
    throw error;
  }
  return sealDataset(datasetId, content, metrics);
}

/** Déchiffre un dataset « en enclave » + vérifie l'intégrité Merkle. Le plaintext ne sort jamais. */
async function decryptDataset({ datasetId, cid, wrappedKey, merkleRoot }: DatasetRef, signal?: AbortSignal): Promise<Buffer> {
  const blob = await fetchFromIpfs(cid, signal);
  const payload = JSON.parse(blob.toString()) as EncryptedPayload;
  const plaintext = decrypt(payload, unwrapKey(wrappedKey, datasetKeyContext(datasetId)));
  if (!verifyRoot(plaintext, merkleRoot, DEFAULT_CHUNK_SIZE)) {
    throw new Error(`Intégrité Merkle invalide pour ${datasetId}`);
  }
  return plaintext;
}

/** Même classement que le worker : une exception du calcul pur vient des données. */
function trainOnData(input: DatasetRef, plaintext: Buffer) {
  try {
    return trainSelectedModel(input, plaintext);
  } catch {
    throw new AppError(INVALID_DATASET_MESSAGE, 422);
  }
}

/** Output-gate : un modèle hors plafond vient des données. */
function gate(model: TrainedModel): TrainedModel {
  try {
    return gateModel(model).model;
  } catch {
    throw new AppError(INVALID_DATASET_MESSAGE, 422);
  }
}

/** Message sûr : un fichier trop lourd pour le délai ou la mémoire du calcul confidentiel. */
export const TRAINING_LIMIT_MESSAGE = "Calcul trop long ou trop lourd pour ce fichier : réduis le nombre de lignes ou de variables";

/**
 * Entraînement sans devis (self-train, emprunt v6). Dans l'enclave, le calcul passe toujours par
 * le worker borné. Le délai ne court qu'après le téléchargement et le déchiffrement : une
 * passerelle IPFS lente garde ses reprises et n'est pas imputée au fichier. Un délai ou une
 * mémoire épuisés sont une erreur liée au fichier (422) : coût et quota restent consommés, mais
 * le coupe-circuit de la plateforme n'est pas touché.
 */
async function trainBounded(input: DatasetRef, maxExecutionMs: number | undefined): Promise<TrainedModel> {
  const plaintext = await decryptDataset(input);
  if (plaintext.length > MAX_DATASET_BYTES) throw new AppError("Taille du dataset invalide", 413);
  if (maxExecutionMs === undefined) return gate(trainOnData(input, plaintext));
  let model: TrainedModel;
  try {
    model = await trainInWorker(input, plaintext, AbortSignal.timeout(maxExecutionMs));
  } catch (error) {
    if (error instanceof TrainingLimitExceeded) throw new AppError(TRAINING_LIMIT_MESSAGE, 422);
    throw error;
  }
  return gate(model);
}

/** Déchiffre → entraîne → output-gate, sous un seul délai : celui du devis facturé. */
async function trainQuoted(input: DatasetRef, signal: AbortSignal, maxDatasetBytes: number): Promise<TrainedModel> {
  const plaintext = await decryptDataset(input, signal);
  if (plaintext.length > maxDatasetBytes) throw new AppError("Taille du dataset invalide", 413);
  return gate(await trainInWorker(input, plaintext, signal));
}

interface SealedModel {
  modelCid: string;
  metrics: Record<string, number>;
}

function sealedResult(model: TrainedModel): SealedModel {
  return { modelCid: servedModelFingerprint(model), metrics: model.metrics };
}

/**
 * Scelle le modèle sous `ref` dans le volume privé du runner, ou retrouve celui d'une exécution
 * précédente : une reprise après scellement ne réentraîne pas. Un modèle d'un autre
 * propriétaire n'est jamais rendu.
 */
async function sealOrReuse(ref: ModelRef, owner: string, train: () => Promise<TrainedModel>): Promise<SealedModel> {
  const existing = loadServedModel(ref);
  if (existing) {
    if (existing.owner !== canonicalSubject(owner)) throw new AppError("Modèle réservé au propriétaire", 403);
    return sealedResult(existing.model);
  }
  const model = await train();
  saveServedModel(ref, owner, model);
  return sealedResult(model);
}

/**
 * Entraînement budgété puis scellé sous `ref`. Si le registre de budget rend le résultat d'une
 * exécution déjà close sans relancer le calcul, le modèle doit encore être présent dans le volume.
 */
async function trainServed(ref: ModelRef, owner: string, input: DatasetRef, maxExecutionMs: number | undefined): Promise<SealedModel> {
  let ran = false;
  const result = await budgetRunnerJob("training", `served:${modelRefString(ref)}`, input, async () => {
    ran = true;
    return sealOrReuse(ref, owner, () => trainBounded(input, maxExecutionMs));
  });
  if (ran) return result;
  const stored = loadServedModel(ref);
  if (!stored || stored.owner !== canonicalSubject(owner)) throw new AppError("Modèle privé indisponible", 503);
  return sealedResult(stored.model);
}

const defaultExecutionMs = () => process.env.TEE_MODE === "phala" ? trainingTimeoutMs() : undefined;

/** Self-train : le modèle reste scellé sous `{ kind: "job", id: jobId }`, jamais livré. */
export async function runSelfTraining(
  input: SelfTrainingInput,
  maxExecutionMs = defaultExecutionMs(),
): Promise<{ servedModelId: string } & SealedModel> {
  const sealed = await trainServed({ kind: "job", id: input.jobId }, input.owner, input, maxExecutionMs);
  return { servedModelId: input.jobId, ...sealed };
}

/**
 * Verrou d'escrow sur le rail EVM : un préimage de 32 octets et son empreinte SHA-256.
 *
 * Le contrat compare `sha256(preimage)` au hashlock, et `release()` publie le
 * préimage brut.
 */
export function escrowLock(loanId: string, borrower: string): EvmEscrowLock {
  const preimage = deriveKey(getMasterKey(), evmEscrowKeyContext(loanId, borrower));
  return {
    preimage: `0x${preimage.toString("hex")}`,
    hashlock: `0x${createHash("sha256").update(preimage).digest("hex")}`,
  };
}

/** Hashlock seul, pour le `lock()` que le borrower signe — le secret ne sort pas. */
export function escrowHashlock(loanId: string, borrower: string): `0x${string}` {
  return escrowLock(loanId, borrower).hashlock;
}

/** Emprunt v6 : le modèle est scellé sous `{ kind: "loan", id: loanId }`, propriétaire le borrower. */
export async function runEvmLoanJob(input: LoanJobInput): Promise<SealedModel> {
  return trainServed({ kind: "loan", id: input.loanId }, input.borrower, input, defaultExecutionMs());
}

export async function runBilledEvmLoanJob(input: LoanJobInput, quote: ComputeQuote): Promise<SealedModel> {
  const ledger = requireBillingBudget();
  const scope = quoteWorkflow(quote);
  const ref: ModelRef = { kind: "loan", id: input.loanId };
  return budgetRunnerJob("training", `served:${modelRefString(ref)}`, input, async () => {
    const startedAt = Date.now();
    const started = performance.now();
    let result: SealedModel | undefined;
    let failure: unknown;
    try {
      result = await sealOrReuse(ref, input.borrower,
        () => trainQuoted(input, AbortSignal.timeout(quote.maxExecutionMs), quote.maxDatasetBytes));
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // Une mesure absente après crash ne devient jamais la consommation maximale du devis.
      const elapsedMs = Math.min(quote.maxExecutionMs, Math.max(0, Math.floor(performance.now() - started)));
      ledger.recordExecutionEvidence(scope,
        JSON.stringify({ version: 1, quoteHash: scope.fingerprint, startedAt, elapsedMs, success: Boolean(result) }),
        result ? JSON.stringify(result) : undefined, result ? true : countsAsRunnerFailure(failure));
    }
  });
}
