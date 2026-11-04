import "server-only";
import { createHash, createHmac } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { deriveKey, getMasterKey, safeEqual } from "@/lib/crypto/encryption";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import type { DatasetRef } from "@/lib/tee/contract";
import type { ModelId } from "@/lib/models/registry";
import { trustedEscrowBinding } from "@/lib/evm/history";
import type { SignedComputeQuote } from "@/lib/billing/quote";
import { DEFAULT_MAX_RENTAL_DAYS, isValidRentalDays } from "@/lib/billing/rental";

/**
 * Reçu de scellement d'un dataset. v4 (D-29) signe `maxRentalDays` ; un reçu v3, émis avant, reste
 * valide et `verifyDatasetReceipt` le lit avec `maxRentalDays = DEFAULT_MAX_RENTAL_DAYS` (30 jours).
 */
export interface DatasetReceipt {
  version: 3 | 4;
  kind: "dataset";
  datasetId: string;
  owner: string;
  cid: string;
  wrappedKeyHash: string;
  merkleRoot: string;
  priceUsdcAtomic: string;
  challengeDays: number;
  modelId: ModelId;
  modelVersion: string;
  maxRentalDays: number;
}

export interface TrainingReceipt {
  version: 3;
  kind: "training";
  jobId: string;
  datasetId: string;
  owner: string;
  modelCid: string;
  modelId: ModelId;
  modelVersion: string;
}

/**
 * `modelCid` : empreinte `sm1…` du modèle scellé dans le runner (served-models.ts). Les reçus émis
 * avant la suppression de la livraison portent aussi `deliveryPublicKey` et `releaseEnvelopeHash`,
 * ignorés : le règlement ne dépend que du reçu signé et du préimage dérivé dans le runner.
 */
export interface LoanReceipt {
  version: 3;
  kind: "loan";
  loanId: string;
  datasetId: string;
  borrower: string;
  provider: string;
  modelCid: string;
  loanKey: string;
  chainId: number;
  escrow: string;
  amountUsdcAtomic: string;
  challengeDays: number;
  modelId: ModelId;
  modelVersion: string;
  attestationHash: string;
  billingQuote?: SignedComputeQuote;
}

type Receipt = DatasetReceipt | TrainingReceipt | LoanReceipt;

function receiptKey(): Buffer {
  return deriveKey(getMasterKey(), "runner-receipt:hmac:v3");
}

function issue(payload: Receipt): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", receiptKey()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verify<T extends Receipt["kind"]>(token: string, kind: T): Extract<Receipt, { kind: T }> {
  const separator = token.indexOf(".");
  if (separator < 1 || token.length > 8_192) throw new AppError("Reçu runner invalide", 401);
  const body = token.slice(0, separator);
  const signature = Buffer.from(token.slice(separator + 1), "base64url");
  let receipt: Receipt;
  try {
    receipt = JSON.parse(Buffer.from(body, "base64url").toString()) as Receipt;
  } catch {
    throw new AppError("Reçu runner invalide", 401);
  }
  if (!receipt || !(receipt.version === 3 || (receipt.kind === "dataset" && receipt.version === 4)) || receipt.kind !== kind) {
    throw new AppError("Reçu runner invalide", 401);
  }
  const expected = createHmac("sha256", receiptKey()).update(body).digest();
  if (!safeEqual(signature, expected)) throw new AppError("Reçu runner invalide", 401);
  return receipt as Extract<Receipt, { kind: T }>;
}

function wrappedKeyHash(wrappedKey: string): string {
  return createHash("sha256").update(wrappedKey).digest("hex");
}

export function issueDatasetReceipt(owner: string, dataset: DatasetRef): string {
  return issue({
    version: 4,
    kind: "dataset",
    datasetId: dataset.datasetId,
    owner,
    cid: dataset.cid,
    wrappedKeyHash: wrappedKeyHash(dataset.wrappedKey),
    merkleRoot: dataset.merkleRoot,
    priceUsdcAtomic: dataset.priceUsdcAtomic,
    challengeDays: dataset.challengeDays,
    modelId: dataset.modelId,
    modelVersion: dataset.modelVersion,
    maxRentalDays: dataset.maxRentalDays,
  });
}

export function verifyDatasetReceipt(token: string, dataset: DatasetRef): DatasetReceipt {
  const signed = verify(token, "dataset");
  const legacy = signed.version === 3 && signed.maxRentalDays === undefined;
  if (!legacy && !(signed.version === 4 && isValidRentalDays(signed.maxRentalDays))) throw new AppError("Reçu runner invalide", 401);
  const receipt: DatasetReceipt = legacy ? { ...signed, maxRentalDays: DEFAULT_MAX_RENTAL_DAYS } : signed;
  if (
    receipt.datasetId !== dataset.datasetId ||
    receipt.cid !== dataset.cid ||
    receipt.wrappedKeyHash !== wrappedKeyHash(dataset.wrappedKey) ||
    receipt.merkleRoot !== dataset.merkleRoot ||
    receipt.priceUsdcAtomic !== dataset.priceUsdcAtomic ||
    receipt.challengeDays !== dataset.challengeDays ||
    receipt.maxRentalDays !== dataset.maxRentalDays ||
    receipt.modelId !== dataset.modelId ||
    receipt.modelVersion !== dataset.modelVersion
  ) {
    throw new AppError("Reçu dataset hors scope", 401);
  }
  return receipt;
}

export function issueTrainingReceipt(input: Omit<TrainingReceipt, "version" | "kind">): string {
  return issue({ version: 3, kind: "training", ...input });
}

export function issueLoanReceipt(input: Omit<LoanReceipt, "version" | "kind">): string {
  return issue({ version: 3, kind: "loan", ...input });
}

export function verifyLoanReceipt(token: string, loanId: string): LoanReceipt {
  const receipt = verify(token, "loan");
  if (receipt.loanId !== loanId) throw new AppError("Reçu d’emprunt hors scope", 401);
  const { chainId, escrow } = evmEscrowBinding();
  if (receipt.chainId !== chainId || receipt.escrow !== escrow) {
    throw new AppError("Reçu d’emprunt émis pour une autre chaîne ou un autre contrat", 409);
  }
  return receipt;
}

/**
 * Reçu d'un prêt déjà réglé, pour la prédiction : l'escrow peut être un déploiement antérieur,
 * pourvu qu'il reste autorisé (`trustedEscrowBinding`). Le règlement, lui, exige l'escrow courant.
 */
export function verifySettledLoanReceipt(token: string, loanId: string): LoanReceipt {
  const receipt = verify(token, "loan");
  if (receipt.loanId !== loanId) throw new AppError("Reçu d’emprunt hors scope", 401);
  trustedEscrowBinding(receipt);
  return receipt;
}
