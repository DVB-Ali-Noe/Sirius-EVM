import "server-only";
import {
  hashes,
  unixTimeToRippleTime,
  xrpToDrops,
  type EscrowCreate,
  type TransactionMetadata,
  type Wallet,
} from "xrpl";
import { AppError } from "@/lib/app-error";
import { getClient } from "./client";
import { assertTesSuccess, submitTx } from "./tx";

export interface EscrowCreateResult {
  sequence: number; // OfferSequence à réutiliser pour finish/cancel
  txHash: string;
}

export type EscrowCreateReconciliation = "confirmed" | "failed" | "pending";

export interface LiveEscrow {
  LedgerEntryType: "Escrow";
  Account: string;
  Destination: string;
  Amount: string;
  Condition?: string;
  CancelAfter?: number;
}

export const MIN_ESCROW_REMAINING_SECONDS = 10 * 60;

interface LiveEscrowScope {
  owner: string;
  destination: string;
  amountDrops: string;
  conditionHex: string;
  cancelAfter: number;
  minimumRemainingSeconds?: number;
  nowRippleTime?: number;
}

function rippledCode(error: unknown): unknown {
  return (error as { data?: { error?: unknown } }).data?.error;
}

export async function reconcileEscrowCreate(
  txHash: string,
  lastLedgerSequence: number,
): Promise<EscrowCreateReconciliation> {
  const client = await getClient();
  try {
    const { result } = await client.request({ command: "tx", transaction: txHash, binary: false });
    if (!result.validated) return "pending";
    const meta = result.meta as TransactionMetadata | string | undefined;
    return meta && typeof meta !== "string" && meta.TransactionResult === "tesSUCCESS"
      ? "confirmed"
      : "failed";
  } catch (error) {
    if (rippledCode(error) !== "txnNotFound") return "pending";
  }
  const ledgerIndex = await client.getLedgerIndex().catch(() => null);
  return ledgerIndex !== null && ledgerIndex > lastLedgerSequence ? "failed" : "pending";
}

export async function liveEscrow(owner: string, sequence: number): Promise<LiveEscrow | null> {
  const client = await getClient();
  try {
    const { result } = await client.request({
      command: "ledger_entry",
      escrow: { owner, seq: sequence },
      ledger_index: "validated",
      binary: false,
    });
    return result.node as LiveEscrow;
  } catch (error) {
    if (rippledCode(error) === "entryNotFound") return null;
    throw new AppError("État live de l’escrow indisponible", 503);
  }
}

export async function validatedRippleTime(): Promise<number> {
  try {
    const { result } = await getClient().then((client) =>
      client.request({
        command: "ledger",
        ledger_index: "validated",
        transactions: false,
        expand: false,
      }),
    );
    if (!result.validated || !Number.isSafeInteger(result.ledger.close_time)) throw new Error();
    return result.ledger.close_time;
  } catch {
    throw new AppError("Horloge du ledger XRPL indisponible", 503);
  }
}

export async function assertLiveEscrow(input: {
  owner: string;
  destination: string;
  sequence: number;
  amountDrops: string;
  conditionHex: string;
  cancelAfter: number;
  minimumRemainingSeconds?: number;
}): Promise<void> {
  const [escrow, nowRippleTime] = await Promise.all([
    liveEscrow(input.owner, input.sequence),
    validatedRippleTime(),
  ]);
  assertLiveEscrowScope(escrow, { ...input, nowRippleTime });
}

export function assertLiveEscrowScope(
  escrow: LiveEscrow | null,
  input: LiveEscrowScope,
): void {
  if (
    !escrow ||
    escrow.LedgerEntryType !== "Escrow" ||
    escrow.Account !== input.owner ||
    escrow.Destination !== input.destination ||
    escrow.Amount !== input.amountDrops ||
    escrow.Condition !== input.conditionHex ||
    !Number.isSafeInteger(escrow.CancelAfter) ||
    escrow.CancelAfter !== input.cancelAfter
  ) {
    throw new AppError("Escrow XRPL inactif ou hors scope", 409);
  }
  const now = input.nowRippleTime ?? unixTimeToRippleTime(Date.now());
  if (escrow.CancelAfter <= now + (input.minimumRemainingSeconds ?? MIN_ESCROW_REMAINING_SECONDS)) {
    throw new AppError("Escrow XRPL expiré ou trop proche de son expiration", 410);
  }
}

/**
 * Autofill d'un `EscrowCreate` SANS signature : le blob signé provient du wallet
 * du borrower (embarqué ou externe). Le borrower doit être activé on-chain
 * (autofill lit sa Sequence). Le backend re-vérifie puis soumet (cf. submitSignedEscrow).
 */
export async function buildEscrowCreate(
  account: string,
  destination: string,
  amountDrops: string,
  conditionHex: string,
  cancelAfter: Date,
): Promise<EscrowCreate> {
  const client = await getClient();
  const tx: EscrowCreate = {
    TransactionType: "EscrowCreate",
    Account: account,
    Destination: destination,
    Amount: amountDrops,
    Condition: conditionHex,
    CancelAfter: unixTimeToRippleTime(cancelAfter.getTime()),
  };
  return client.autofill(tx);
}

/** Soumet un `EscrowCreate` déjà signé côté client (tx_blob) + garde tesSUCCESS. */
export async function submitSignedEscrow(txBlob: string): Promise<string> {
  const client = await getClient();
  const expectedHash = hashes.hashSignedTx(txBlob);
  try {
    const res = await client.submitAndWait(txBlob, { failHard: true });
    assertTesSuccess(res, "EscrowCreate");
    return res.result.hash;
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

/**
 * TokenEscrow conditionnel en XRP (XLS-85). Le release exige le fulfillment
 * de `conditionHex` (détenu par le vérificateur TEE). `cancelAfter` = fin de la
 * challenge period → au-delà, remboursement du borrower via escrowCancel.
 */
export async function escrowCreate(
  wallet: Wallet,
  destination: string,
  amountXrp: string,
  conditionHex: string,
  cancelAfter: Date,
): Promise<EscrowCreateResult> {
  const client = await getClient();
  const tx: EscrowCreate = {
    TransactionType: "EscrowCreate",
    Account: wallet.address,
    Destination: destination,
    Amount: xrpToDrops(amountXrp),
    Condition: conditionHex,
    CancelAfter: unixTimeToRippleTime(cancelAfter.getTime()),
  };
  const prepared = await client.autofill(tx);

  const sequence = prepared.Sequence;
  if (sequence === undefined) throw new Error("Sequence manquante après autofill");

  const res = await client.submitAndWait(prepared, { wallet, failHard: true });
  assertTesSuccess(res, "EscrowCreate");
  return { sequence, txHash: res.result.hash };
}

/** Release de l'escrow : révèle le fulfillment (inc.3 — déclenché par le TEE). */
export async function escrowFinish(
  wallet: Wallet,
  owner: string,
  offerSequence: number,
  conditionHex: string,
  fulfillmentHex: string,
): Promise<string> {
  const client = await getClient();
  const res = await submitTx(
    client,
    {
      TransactionType: "EscrowFinish",
      Account: wallet.address,
      Owner: owner,
      OfferSequence: offerSequence,
      Condition: conditionHex,
      Fulfillment: fulfillmentHex,
    },
    wallet,
  );
  return res.result.hash;
}

/** Remboursement du borrower après CancelAfter (inc.4). */
export async function escrowCancel(
  wallet: Wallet,
  owner: string,
  offerSequence: number,
): Promise<string> {
  const client = await getClient();
  const res = await submitTx(
    client,
    {
      TransactionType: "EscrowCancel",
      Account: wallet.address,
      Owner: owner,
      OfferSequence: offerSequence,
    },
    wallet,
  );
  return res.result.hash;
}
