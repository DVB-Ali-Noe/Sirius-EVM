import "server-only";
import { Wallet, type EscrowCreate, type TransactionMetadata, type TxResponse } from "xrpl";
import { AppError } from "@/lib/app-error";
import { getClient } from "@/lib/xrpl/client";
import {
  escrowCancel,
  escrowFinish,
  liveEscrow,
  validatedRippleTime,
} from "@/lib/xrpl/escrow";
import { escrowRelease } from "@/lib/tee/core";
import type { RunnerEscrowReconciliation } from "@/lib/tee/contract";
import type { LoanReceipt } from "./receipt";

interface EscrowScope {
  borrower: string;
  conditionHex: string;
  createLedger: number;
  escrowSequence: number;
  cancelAfter: number;
  destination: string;
  amountDrops: string;
}

interface ResolutionEntry {
  hash?: string;
  meta: TransactionMetadata | string;
  tx: {
    TransactionType?: string;
    Owner?: string;
    OfferSequence?: number;
    Condition?: string;
  };
}

export const MAX_RESOLUTION_PAGES = 20;

export function assertResolutionScanBudget(pageCount: number, hasMore: boolean): void {
  if (hasMore && pageCount >= MAX_RESOLUTION_PAGES) {
    throw new AppError("Historique XRPL trop volumineux pour une réconciliation synchrone", 503);
  }
}

function settlementWallet(): Wallet {
  const seed =
    process.env.XRPL_SETTLEMENT_SEED ||
    (process.env.NODE_ENV !== "production" ? process.env.XRPL_VERIFIER_SEED : undefined);
  if (!seed) throw new Error("XRPL_SETTLEMENT_SEED manquante dans le runner");
  return Wallet.fromSeed(seed);
}

export function runnerSettlementAddress(): string {
  return settlementWallet().address;
}

export function escrowResolutionFromEntry(
  entry: ResolutionEntry,
  scope: Pick<EscrowScope, "borrower" | "escrowSequence" | "conditionHex">,
): Exclude<RunnerEscrowReconciliation, { state: "active" }> | null {
  if (
    typeof entry.meta === "string" ||
    entry.meta.TransactionResult !== "tesSUCCESS" ||
    typeof entry.hash !== "string"
  ) {
    return null;
  }
  if (
    entry.tx.Owner !== scope.borrower ||
    Number(entry.tx.OfferSequence) !== scope.escrowSequence
  ) {
    return null;
  }
  if (entry.tx.TransactionType === "EscrowCancel") {
    return { state: "cancelled", txHash: entry.hash };
  }
  if (
    entry.tx.TransactionType === "EscrowFinish" &&
    entry.tx.Condition === scope.conditionHex
  ) {
    return { state: "settled", txHash: entry.hash };
  }
  return null;
}

async function validatedEscrowScope(input: {
  loanId: string;
  borrower: string;
  escrowTxHash: string;
  escrowSequence: number;
  receipt?: LoanReceipt;
}): Promise<EscrowScope> {
  if (!/^[A-Fa-f0-9]{64}$/.test(input.escrowTxHash)) {
    throw new AppError("Hash EscrowCreate invalide", 400);
  }
  const client = await getClient();
  let result: TxResponse<EscrowCreate>["result"];
  try {
    const response = await client.request({
      command: "tx",
      transaction: input.escrowTxHash,
      binary: false,
    });
    result = response.result as TxResponse<EscrowCreate>["result"];
  } catch {
    throw new AppError("EscrowCreate XRPL introuvable", 409);
  }
  const meta = result.meta as TransactionMetadata | string | undefined;
  const tx = result.tx_json as EscrowCreate;
  const conditionHex = escrowRelease(input.loanId, input.borrower).conditionHex;
  if (
    !result.validated ||
    !meta ||
    typeof meta === "string" ||
    meta.TransactionResult !== "tesSUCCESS" ||
    tx.TransactionType !== "EscrowCreate" ||
    tx.Account !== input.borrower ||
    tx.Sequence !== input.escrowSequence ||
    tx.Condition !== conditionHex ||
    typeof tx.Destination !== "string" ||
    typeof tx.Amount !== "string" ||
    !Number.isSafeInteger(tx.CancelAfter) ||
    !Number.isSafeInteger(result.ledger_index)
  ) {
    throw new AppError("EscrowCreate hors scope du reaper", 409);
  }
  if (
    input.receipt &&
    (input.receipt.borrower !== input.borrower ||
      input.receipt.escrowTxHash !== input.escrowTxHash ||
      input.receipt.escrowSequence !== input.escrowSequence ||
      input.receipt.provider !== tx.Destination ||
      input.receipt.amountDrops !== tx.Amount)
  ) {
    throw new AppError("Reçu d’emprunt hors scope de l’escrow", 409);
  }
  return {
    borrower: input.borrower,
    conditionHex,
    createLedger: Number(result.ledger_index),
    escrowSequence: input.escrowSequence,
    cancelAfter: Number(tx.CancelAfter),
    destination: tx.Destination,
    amountDrops: tx.Amount,
  };
}

async function findResolution(scope: EscrowScope): Promise<Exclude<RunnerEscrowReconciliation, { state: "active" }> | null> {
  const client = await getClient();
  let marker: unknown;
  let pageCount = 0;
  do {
    pageCount += 1;
    const { result } = await client.request({
      command: "account_tx",
      account: scope.borrower,
      ledger_index_min: scope.createLedger,
      ledger_index_max: -1,
      limit: 200,
      forward: false,
      ...(marker === undefined ? {} : { marker }),
    });
    for (const entry of result.transactions) {
      const resolution = escrowResolutionFromEntry(
        {
          hash: entry.hash,
          meta: entry.meta as TransactionMetadata | string,
          tx: entry.tx_json as ResolutionEntry["tx"],
        },
        scope,
      );
      if (resolution) return resolution;
    }
    marker = result.marker;
    assertResolutionScanBudget(pageCount, marker !== undefined);
  } while (marker !== undefined);
  return null;
}

async function reconcileResolution(scope: EscrowScope) {
  try {
    return await findResolution(scope);
  } catch {
    throw new AppError("Réconciliation XRPL de l’escrow indisponible", 503);
  }
}

export async function reconcileLoanEscrowInRunner(input: {
  loanId: string;
  borrower: string;
  escrowTxHash: string;
  escrowSequence: number;
  receipt?: LoanReceipt;
}): Promise<RunnerEscrowReconciliation> {
  const scope = await validatedEscrowScope(input);
  const resolution = await reconcileResolution(scope);
  if (resolution) return resolution;

  const [escrow, nowRippleTime] = await Promise.all([
    liveEscrow(scope.borrower, scope.escrowSequence),
    validatedRippleTime(),
  ]);
  if (!escrow) {
    const recovered = await reconcileResolution(scope);
    if (recovered) return recovered;
    throw new AppError("Escrow résolu mais transaction XRPL introuvable", 503);
  }
  if (
    escrow.Account !== scope.borrower ||
    escrow.Destination !== scope.destination ||
    escrow.Amount !== scope.amountDrops ||
    escrow.Condition !== scope.conditionHex ||
    escrow.CancelAfter !== scope.cancelAfter
  ) {
    throw new AppError("Escrow live hors scope du reaper", 409);
  }
  if (scope.cancelAfter > nowRippleTime) return { state: "active" };

  try {
    const txHash = await escrowCancel(settlementWallet(), scope.borrower, scope.escrowSequence);
    return { state: "cancelled", txHash };
  } catch {
    const recovered = await reconcileResolution(scope);
    if (recovered) return recovered;
    throw new AppError("Annulation XRPL de l’escrow échouée", 502);
  }
}

export async function settleEscrowInRunner(receipt: LoanReceipt): Promise<string> {
  const scope = await validatedEscrowScope({
    loanId: receipt.loanId,
    borrower: receipt.borrower,
    escrowTxHash: receipt.escrowTxHash,
    escrowSequence: receipt.escrowSequence,
    receipt,
  });
  const existing = await reconcileResolution(scope);
  if (existing?.state === "settled") return existing.txHash;
  if (existing?.state === "cancelled") throw new AppError("Escrow XRPL annulé", 410);
  if (!(await liveEscrow(receipt.borrower, receipt.escrowSequence))) {
    throw new AppError("Escrow XRPL inactif", 410);
  }

  const release = escrowRelease(receipt.loanId, receipt.borrower);
  try {
    return await escrowFinish(
      settlementWallet(),
      receipt.borrower,
      receipt.escrowSequence,
      release.conditionHex,
      release.fulfillmentHex,
    );
  } catch {
    const recovered = await reconcileResolution(scope);
    if (recovered?.state === "settled") return recovered.txHash;
    if (recovered?.state === "cancelled") throw new AppError("Escrow XRPL annulé", 410);
    throw new AppError("Règlement XRPL du runner échoué", 502);
  }
}
