import "server-only";
import { createHash, createHmac } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { deriveKey, getMasterKey, safeEqual } from "@/lib/crypto/encryption";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import type { DatasetRef } from "@/lib/tee/contract";

export interface DatasetReceipt {
  version: 1;
  kind: "dataset";
  datasetId: string;
  owner: string;
  cid: string;
  wrappedKeyHash: string;
  merkleRoot: string;
  priceDrops: string;
  challengeDays: number;
  /** Prix en wei pour le rail EVM. Absent sur les datasets scellés avant la migration. */
  priceWei?: string;
}

export interface TrainingReceipt {
  version: 1;
  kind: "training";
  jobId: string;
  datasetId: string;
  owner: string;
  modelCid: string;
}

export interface LoanReceipt {
  version: 1;
  kind: "loan";
  loanId: string;
  datasetId: string;
  borrower: string;
  provider: string;
  modelCid: string;
  escrowTxHash: string;
  escrowSequence: number;
  deliveryPublicKey: string;
  amountDrops: string;
  challengeDays: number;
  releaseEnvelopeHash: string;
  attestationHash: string;
}

/**
 * Reçu d'emprunt sur le rail EVM.
 *
 * Type distinct de {@link LoanReceipt}, et non une variante de celui-ci : le `kind`
 * entre dans le HMAC, donc un reçu émis pour XRPL ne peut pas être présenté sur EVM
 * ni l'inverse. Pendant la coexistence des deux rails, c'est ce qui empêche qu'un
 * prêt ouvert sur l'un soit réglé sur l'autre.
 *
 * Les champs diffèrent parce que les chaînes diffèrent : plus de `escrowSequence`
 * (l'EVM n'en a pas), le montant est en wei et non en drops, et `loanKey` remplace
 * le couple (compte, séquence) comme identifiant on-chain du prêt.
 */
export interface EvmLoanReceipt {
  version: 1;
  kind: "evm-loan";
  loanId: string;
  datasetId: string;
  borrower: string;
  provider: string;
  modelCid: string;
  loanKey: string;
  chainId: number;
  escrow: string;
  amountWei: string;
  challengeDays: number;
  deliveryPublicKey: string;
  releaseEnvelopeHash: string;
  attestationHash: string;
}

type Receipt = DatasetReceipt | TrainingReceipt | LoanReceipt | EvmLoanReceipt;

function receiptKey(): Buffer {
  return deriveKey(getMasterKey(), "runner-receipt:hmac:v1");
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
  const expected = createHmac("sha256", receiptKey()).update(body).digest();
  if (!safeEqual(signature, expected)) throw new AppError("Reçu runner invalide", 401);

  let receipt: Receipt;
  try {
    receipt = JSON.parse(Buffer.from(body, "base64url").toString()) as Receipt;
  } catch {
    throw new AppError("Reçu runner invalide", 401);
  }
  if (receipt.version !== 1 || receipt.kind !== kind) throw new AppError("Reçu runner invalide", 401);
  return receipt as Extract<Receipt, { kind: T }>;
}

function wrappedKeyHash(wrappedKey: string): string {
  return createHash("sha256").update(wrappedKey).digest("hex");
}

export function issueDatasetReceipt(owner: string, dataset: DatasetRef): string {
  return issue({
    version: 1,
    kind: "dataset",
    datasetId: dataset.datasetId,
    owner,
    cid: dataset.cid,
    wrappedKeyHash: wrappedKeyHash(dataset.wrappedKey),
    merkleRoot: dataset.merkleRoot,
    priceDrops: dataset.priceDrops,
    challengeDays: dataset.challengeDays,
    ...(dataset.priceWei ? { priceWei: dataset.priceWei } : {}),
  });
}

export function verifyDatasetReceipt(token: string, dataset: DatasetRef): DatasetReceipt {
  const receipt = verify(token, "dataset");
  if (
    receipt.datasetId !== dataset.datasetId ||
    receipt.cid !== dataset.cid ||
    receipt.wrappedKeyHash !== wrappedKeyHash(dataset.wrappedKey) ||
    receipt.merkleRoot !== dataset.merkleRoot ||
    receipt.priceDrops !== dataset.priceDrops ||
    receipt.challengeDays !== dataset.challengeDays ||
    receipt.priceWei !== dataset.priceWei
  ) {
    throw new AppError("Reçu dataset hors scope", 401);
  }
  return receipt;
}

export function issueTrainingReceipt(input: Omit<TrainingReceipt, "version" | "kind">): string {
  return issue({ version: 1, kind: "training", ...input });
}

export function verifyTrainingReceipt(token: string, jobId: string): TrainingReceipt {
  const receipt = verify(token, "training");
  if (receipt.jobId !== jobId) throw new AppError("Reçu d’entraînement hors scope", 401);
  return receipt;
}

export function issueLoanReceipt(input: Omit<LoanReceipt, "version" | "kind">): string {
  return issue({ version: 1, kind: "loan", ...input });
}

export function verifyLoanReceipt(token: string, loanId: string): LoanReceipt {
  const receipt = verify(token, "loan");
  if (receipt.loanId !== loanId) throw new AppError("Reçu d’emprunt hors scope", 401);
  return receipt;
}

export function issueEvmLoanReceipt(input: Omit<EvmLoanReceipt, "version" | "kind">): string {
  return issue({ version: 1, kind: "evm-loan", ...input });
}

/**
 * Vérifie un reçu EVM et le recroise avec la liaison de chaîne du runner.
 *
 * Le contrôle `chainId`/`escrow` n'est pas redondant avec le HMAC : le HMAC prouve
 * que le runner a bien émis ce reçu, mais un runner reconfiguré — nouveau contrat,
 * autre réseau — dérive désormais d'autres secrets. Accepter un ancien reçu
 * produirait un préimage qui n'ouvre rien, après paiement.
 */
export function verifyEvmLoanReceipt(token: string, loanId: string): EvmLoanReceipt {
  const receipt = verify(token, "evm-loan");
  if (receipt.loanId !== loanId) throw new AppError("Reçu d’emprunt hors scope", 401);

  const { chainId, escrow } = evmEscrowBinding();
  if (receipt.chainId !== chainId || receipt.escrow !== escrow) {
    throw new AppError("Reçu d’emprunt émis pour une autre chaîne ou un autre contrat", 409);
  }
  return receipt;
}

export function assertEvmReleaseEnvelopeHash(receipt: EvmLoanReceipt, persistedHash: string): void {
  if (!/^[a-f0-9]{64}$/.test(persistedHash)) throw new AppError("Accusé de capsule invalide", 400);
  if (receipt.releaseEnvelopeHash !== persistedHash) {
    throw new AppError("Capsule persistée différente de la capsule attestée", 409);
  }
}

export function assertLoanReleaseEnvelopeHash(receipt: LoanReceipt, persistedHash: string): void {
  if (!/^[a-f0-9]{64}$/.test(persistedHash)) {
    throw new AppError("Accusé de capsule invalide", 400);
  }
  if (receipt.releaseEnvelopeHash !== persistedHash) {
    throw new AppError("Capsule persistée différente de la capsule attestée", 409);
  }
}
