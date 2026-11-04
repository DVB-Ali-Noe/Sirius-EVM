import type { DatasetMetrics } from "@/lib/sirius/metrics";
import type { ModelId, ModelSelection } from "@/lib/models/registry";
import type { LoanExecutionAttestation } from "./types";

// Le JSON chiffré en base64 doit rester sous les 4,5 Mo admis par Vercel.
export const MAX_DATASET_BYTES = 3 * 1024 * 1024;
export const DATASET_INGRESS_INFO_PREFIX = "sirius-dataset-ingress-v1:";

export interface DatasetIngressKey {
  version: 1;
  publicKey: string;
  origin: string;
}

export interface DatasetIngressEnvelope {
  version: 1;
  ephemeralPublicKey: string;
  salt: string;
  iv: string;
  ciphertext: string;
}

/**
 * Verrou d'escrow EVM : préimage secret et son empreinte publique.
 *
 * Typés `0x${string}` et non `string` : ces valeurs traversent directement viem et le
 * contrat, où un hexadécimal sans préfixe serait interprété différemment. Le type
 * porte la convention plutôt que de la laisser à la discipline de l'appelant.
 */
export interface EvmEscrowLock {
  hashlock: `0x${string}`;
  preimage: `0x${string}`;
}

/**
 * Contrat de la frontière Next ↔ runner confidentiel (inc.3d-B). Le runner est le SEUL
 * détenteur de la master key enclave ; le Next lui passe des inputs explicites (jamais de
 * handle DB) et ne voit jamais plaintext / DEK / modèle entraîné / préimage avant le règlement.
 */

/** Référence d'un dataset chiffré au repos (ce que le Next connaît sans jamais déchiffrer). */
export type DatasetRef = {
  datasetId: string; // contexte de wrap de la DEK
  cid: string; // blob chiffré sur IPFS
  wrappedKey: string; // DEK scellée
  merkleRoot: string; // intégrité vérifiée après déchiffrement
  priceUsdcAtomic: string; // prix de location PAR JOUR, authentifié par le reçu runner (USDC, six décimales)
  challengeDays: number;
  maxRentalDays: number; // durée de location maximale (1–365 j), signée dans le reçu runner v4
} & ModelSelection;

/** Entrée d'un self-train : le modèle est scellé dans le runner sous `{ kind: "job", id: jobId }`. */
export type SelfTrainingInput = DatasetRef & {
  jobId: string;
  owner: string;
}

/**
 * Entrée d'un job d'emprunt : juste la ref dataset + le `loanId`. La référence scellée
 * `{ kind: "loan", id: loanId }` et son propriétaire (le borrower) sont fixés DANS le runner.
 */
export type LoanJobInput = DatasetRef & {
  loanId: string;
  borrower: string;
}

/** Sortie du scellement d'un dataset (upload provider) : rien de sensible ne fuit. */
export interface SealDatasetResult {
  cid: string;
  wrappedKey: string;
  merkleRoot: string;
  metrics: DatasetMetrics;
  sizeBytes: number;
}

export interface AuthorizedSealDatasetResult extends SealDatasetResult {
  runnerReceipt: string;
}

/**
 * Résultat d'un self-train : le modèle reste scellé dans le runner. `modelCid` porte l'empreinte
 * `servedModelFingerprint` (`sm1…`), pas un CID IPFS : voir served-models.ts.
 */
export interface SelfTrainingResult {
  servedModelId: string;
  modelCid: string;
  metrics: Record<string, number>;
  /** Colonnes que `predict` attend, dans l'ordre du modèle. */
  features: string[];
  runnerReceipt: string;
}

/** `modelCid` : empreinte `sm1…` du modèle scellé sous `{ kind: "loan", id: loanId }`. */
export interface LoanJobResult {
  modelCid: string;
  metrics: Record<string, number>;
  features: string[];
  attestation: LoanExecutionAttestation;
  loanKey: string;
  hashlock: string;
  runnerReceipt: string;
}

export type RecoveredLoanResult =
  | { state: "missing" | "pending" | "failed" }
  | { state: "ready"; result: LoanJobResult };

/** Modèle scellé dans le runner : un self-train (`job`) ou un prêt (`loan`). */
export type ModelRefKind = "job" | "loan";

export interface ModelRef {
  kind: ModelRefKind;
  id: string;
}

export const MODEL_REF_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Forme canonique `kind:id`, signée dans la prédiction et clé du quota. */
export function modelRefString(ref: ModelRef): string {
  return `${ref.kind}:${ref.id}`;
}

export type PredictionOutputKind = "value" | "decision";

const PREDICTION_OUTPUT_KIND: Record<ModelId, PredictionOutputKind> = {
  linear_regression: "value",
  logistic_regression: "decision",
  gradient_boosted_trees: "decision",
};

export function predictionOutputKind(modelId: ModelId): PredictionOutputKind {
  return PREDICTION_OUTPUT_KIND[modelId];
}

/** Décision : « 0 » ou « 1 ». Valeur : nombre fini déjà arrondi à 3 chiffres significatifs. */
export function isValidPredictionOutput(outputKind: PredictionOutputKind, output: string): boolean {
  if (outputKind === "decision") return output === "0" || output === "1";
  const value = Number(output);
  return output.length > 0 && output.length <= 32 && Number.isFinite(value)
    && String(Number(value.toPrecision(3))) === output;
}

export const PREDICTION_DOMAIN_NAME = "SiriusPrediction";
export const PREDICTION_DOMAIN_VERSION = "2";

export const PREDICTION_EIP712_TYPES = {
  Prediction: [
    { name: "modelRef", type: "string" },
    { name: "modelId", type: "string" },
    { name: "modelVersion", type: "string" },
    { name: "subject", type: "address" },
    { name: "featuresHash", type: "bytes32" },
    { name: "outputKind", type: "string" },
    { name: "output", type: "string" },
    { name: "counter", type: "uint64" },
    { name: "sessionRevision", type: "uint64" },
  ],
} as const;

export interface SignedPrediction {
  modelRef: string;
  modelId: ModelId;
  modelVersion: string;
  outputKind: PredictionOutputKind;
  output: string;
  counter: number;
  signer: `0x${string}`;
  signature: `0x${string}`;
  domain: { name: typeof PREDICTION_DOMAIN_NAME; version: typeof PREDICTION_DOMAIN_VERSION; chainId: number };
  signedMessage: {
    modelRef: string;
    modelId: ModelId;
    modelVersion: string;
    subject: `0x${string}`;
    featuresHash: `0x${string}`;
    outputKind: PredictionOutputKind;
    output: string;
    counter: number;
    sessionRevision: number;
  };
}

export type RunnerEscrowReconciliation =
  | { state: "active" }
  | { state: "cancelled"; txHash: string }
  | { state: "settled"; txHash: string };
