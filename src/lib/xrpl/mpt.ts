import "server-only";
import {
  convertStringToHex,
  hashes,
  type MPTokenIssuanceCreate,
  type MPTokenIssuanceDestroy,
  type TransactionMetadata,
} from "xrpl";
import { getClient } from "./client";
import { assertTesSuccess } from "./tx";
import { AppError } from "@/lib/errors";

// XRPL limite MPTokenMetadata à 1024 octets (raw), avant conversion hex.
const MAX_MPT_METADATA_BYTES = 1024;

export interface DatasetMptMetadata {
  datasetId: string;
  name: string;
  ipfsCid: string;
  merkleRoot: string;
  sizeBytes: number;
}

export interface PreparedDatasetMpt {
  txBlob: string;
  txHash: string;
  lastLedgerSequence: number;
}

export type DatasetMptReconciliation =
  | { state: "confirmed"; issuanceId: string }
  | { state: "failed" | "pending" };

export function encodedDatasetMptMetadata(metadata: DatasetMptMetadata): string {
  const json = JSON.stringify(metadata);
  if (Buffer.byteLength(json, "utf-8") > MAX_MPT_METADATA_BYTES) {
    throw new AppError("Métadonnées MPT trop volumineuses (nom de dataset trop long ?)", 400);
  }
  return convertStringToHex(json);
}

/**
 * Mint le MPT (XLS-33) qui tokenise un dataset : identité on-chain non transférable
 * portant le CID et la racine Merkle. Renvoie le mpt_issuance_id.
 */
export async function buildDatasetMpt(
  issuer: string,
  metadata: DatasetMptMetadata,
): Promise<MPTokenIssuanceCreate> {
  const client = await getClient();
  const input: MPTokenIssuanceCreate = {
    TransactionType: "MPTokenIssuanceCreate",
    Account: issuer,
    AssetScale: 0,
    MaximumAmount: "1",
    MPTokenMetadata: encodedDatasetMptMetadata(metadata),
  };
  const transaction = await client.autofill(input);
  if (
    !Number.isSafeInteger(transaction.Sequence) ||
    !Number.isSafeInteger(transaction.LastLedgerSequence)
  ) {
    throw new AppError("LastLedgerSequence MPT manquant", 503);
  }
  return transaction;
}

export function assertDatasetMptCreateScope(
  tx: MPTokenIssuanceCreate,
  issuer: string,
  metadata: DatasetMptMetadata,
): void {
  const scoped = tx as MPTokenIssuanceCreate & { DomainID?: unknown };
  const flags = tx.Flags ?? 0;
  if (
    tx.TransactionType !== "MPTokenIssuanceCreate" ||
    tx.Account !== issuer ||
    tx.AssetScale !== 0 ||
    tx.MaximumAmount !== "1" ||
    tx.MPTokenMetadata !== encodedDatasetMptMetadata(metadata) ||
    (flags !== 0 && flags !== 0x80000000) ||
    scoped.DomainID !== undefined ||
    tx.TransferFee !== undefined ||
    tx.Delegate !== undefined ||
    tx.Memos !== undefined ||
    tx.SourceTag !== undefined ||
    tx.TicketSequence !== undefined ||
    tx.AccountTxnID !== undefined ||
    !Number.isSafeInteger(tx.Sequence) ||
    !Number.isSafeInteger(tx.LastLedgerSequence)
  ) {
    throw new AppError("MPTokenIssuanceCreate hors scope du dataset", 400);
  }
}

export async function submitPreparedDatasetMpt(prepared: PreparedDatasetMpt): Promise<string> {
  const client = await getClient();
  const res = await client.submitAndWait(prepared.txBlob, { failHard: true });
  assertTesSuccess(res, "MPTokenIssuanceCreate");
  const meta = res.result.meta;
  const id = meta && typeof meta === "object" ? (meta as { mpt_issuance_id?: string }).mpt_issuance_id : undefined;
  if (!id) throw new Error("mpt_issuance_id introuvable après mint");
  return id;
}

export async function reconcileDatasetMpt(
  txHash: string,
  lastLedgerSequence: number,
): Promise<DatasetMptReconciliation> {
  const client = await getClient();
  try {
    const { result } = await client.request({ command: "tx", transaction: txHash, binary: false });
    if (result.validated) {
      const meta = result.meta as (TransactionMetadata & { mpt_issuance_id?: string }) | string | undefined;
      if (
        meta &&
        typeof meta !== "string" &&
        meta.TransactionResult === "tesSUCCESS" &&
        typeof meta.mpt_issuance_id === "string"
      ) {
        return { state: "confirmed", issuanceId: meta.mpt_issuance_id };
      }
      return { state: "failed" };
    }
    return { state: "pending" };
  } catch (error) {
    const code = (error as { data?: { error?: unknown } }).data?.error;
    if (code !== "txnNotFound") return { state: "pending" };
  }

  const ledgerIndex = await client.getLedgerIndex().catch(() => null);
  return ledgerIndex !== null && ledgerIndex > lastLedgerSequence
    ? { state: "failed" }
    : { state: "pending" };
}

/**
 * Détruit l'émission MPT d'un dataset (`MPTokenIssuanceDestroy`). L'issuer doit être
 * le compte émetteur. XRPL rejette la destruction si des tokens circulent encore
 * (`tecHAS_OBLIGATIONS`) → `submitTx` lève alors : l'appelant traite ce cas en
 * best-effort (le crypto-shredding de la data ne dépend pas de la destruction du MPT).
 */
export async function buildDatasetMptDestroy(
  issuer: string,
  issuanceId: string,
): Promise<MPTokenIssuanceDestroy> {
  const client = await getClient();
  const input: MPTokenIssuanceDestroy = {
    TransactionType: "MPTokenIssuanceDestroy",
    Account: issuer,
    MPTokenIssuanceID: issuanceId,
  };
  const transaction = await client.autofill(input);
  if (
    !Number.isSafeInteger(transaction.Sequence) ||
    !Number.isSafeInteger(transaction.LastLedgerSequence)
  ) {
    throw new AppError("LastLedgerSequence MPT manquant", 503);
  }
  return transaction;
}

export function assertDatasetMptDestroyScope(
  tx: MPTokenIssuanceDestroy,
  issuer: string,
  issuanceId: string,
): void {
  const flags = tx.Flags ?? 0;
  if (
    tx.TransactionType !== "MPTokenIssuanceDestroy" ||
    tx.Account !== issuer ||
    tx.MPTokenIssuanceID !== issuanceId ||
    (flags !== 0 && flags !== 0x80000000) ||
    tx.Delegate !== undefined ||
    tx.Memos !== undefined ||
    tx.SourceTag !== undefined ||
    tx.TicketSequence !== undefined ||
    tx.AccountTxnID !== undefined ||
    !Number.isSafeInteger(tx.Sequence) ||
    !Number.isSafeInteger(tx.LastLedgerSequence)
  ) {
    throw new AppError("MPTokenIssuanceDestroy hors scope du dataset", 400);
  }
}

export async function submitSignedDatasetMptDestroy(txBlob: string): Promise<string> {
  const client = await getClient();
  const expectedHash = hashes.hashSignedTx(txBlob);
  try {
    const result = await client.submitAndWait(txBlob, { failHard: true });
    assertTesSuccess(result, "MPTokenIssuanceDestroy");
    return result.result.hash;
  } catch (error) {
    try {
      const { result } = await client.request({ command: "tx", transaction: expectedHash, binary: false });
      const meta = result.meta as TransactionMetadata | string | undefined;
      if (
        result.validated &&
        meta &&
        typeof meta !== "string" &&
        meta.TransactionResult === "tesSUCCESS"
      ) {
        return expectedHash;
      }
    } catch {}
    throw error;
  }
}
