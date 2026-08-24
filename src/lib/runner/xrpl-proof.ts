import "server-only";
import type { EscrowCreate, EscrowFinish, TransactionMetadata } from "xrpl";
import { AppError } from "@/lib/app-error";
import { getClient } from "@/lib/xrpl/client";
import { escrowConditionPublic } from "@/lib/tee/core";
import { assertLiveEscrow, MIN_ESCROW_REMAINING_SECONDS } from "@/lib/xrpl/escrow";

const MAX_PREPARATION_SECONDS = 10 * 60;

async function validatedTx<T extends EscrowCreate | EscrowFinish>(hash: string): Promise<T> {
  if (!/^[A-Fa-f0-9]{64}$/.test(hash)) throw new AppError("Hash XRPL invalide", 400);
  try {
    const { result } = await getClient().then((client) =>
      client.request({ command: "tx", transaction: hash, binary: false }),
    );
    const meta = result.meta as TransactionMetadata | string | undefined;
    if (!result.validated || !meta || typeof meta === "string" || meta.TransactionResult !== "tesSUCCESS") {
      throw new AppError("Transaction XRPL non validée", 409);
    }
    return result.tx_json as T;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("Preuve XRPL indisponible", 503);
  }
}

export async function verifyEscrowCreateProof(input: {
  txHash: string;
  loanId: string;
  borrower: string;
  provider: string;
  sequence: number;
  amountDrops: string;
  challengeDays: number;
}): Promise<void> {
  const tx = await validatedTx<EscrowCreate>(input.txHash);
  assertEscrowCreateScope(tx, input);
  await assertLiveEscrow({
    owner: input.borrower,
    destination: input.provider,
    sequence: input.sequence,
    amountDrops: input.amountDrops,
    conditionHex: escrowConditionPublic(input.loanId, input.borrower),
    cancelAfter: Number(tx.CancelAfter),
    minimumRemainingSeconds: MIN_ESCROW_REMAINING_SECONDS,
  });
}

export function assertEscrowCreateScope(
  tx: EscrowCreate,
  input: {
    loanId: string;
    borrower: string;
    provider: string;
    sequence: number;
    amountDrops: string;
    challengeDays: number;
  },
): void {
  const minimumCancelAfter = Number(tx.date) + input.challengeDays * 86_400 - 120;
  const maximumCancelAfter =
    Number(tx.date) + input.challengeDays * 86_400 + MAX_PREPARATION_SECONDS + 30;
  if (
    tx.TransactionType !== "EscrowCreate" ||
    tx.Account !== input.borrower ||
    tx.Destination !== input.provider ||
    tx.Sequence !== input.sequence ||
    tx.Amount !== input.amountDrops ||
    tx.Condition !== escrowConditionPublic(input.loanId, input.borrower) ||
    tx.FinishAfter !== undefined ||
    !Number.isSafeInteger(tx.date) ||
    !Number.isSafeInteger(tx.CancelAfter) ||
    Number(tx.CancelAfter) < minimumCancelAfter ||
    Number(tx.CancelAfter) > maximumCancelAfter
  ) {
    throw new AppError("EscrowCreate hors scope du grant", 403);
  }
}

export async function verifyEscrowFinishProof(input: {
  txHash: string;
  loanId: string;
  borrower: string;
  sequence: number;
}): Promise<void> {
  const tx = await validatedTx<EscrowFinish>(input.txHash);
  assertEscrowFinishScope(tx, input);
}

export async function verifiedEscrowFinishFulfillment(input: {
  txHash: string;
  loanId: string;
  borrower: string;
  sequence: number;
}): Promise<string> {
  const tx = await validatedTx<EscrowFinish>(input.txHash);
  assertEscrowFinishScope(tx, input);
  if (typeof tx.Fulfillment !== "string" || !/^(?:[A-Fa-f0-9]{2})+$/.test(tx.Fulfillment)) {
    throw new AppError("Fulfillment XRPL absent", 409);
  }
  return tx.Fulfillment;
}

export function assertEscrowFinishScope(
  tx: EscrowFinish,
  input: { loanId: string; borrower: string; sequence: number },
): void {
  if (
    tx.TransactionType !== "EscrowFinish" ||
    tx.Owner !== input.borrower ||
    Number(tx.OfferSequence) !== input.sequence ||
    tx.Condition !== escrowConditionPublic(input.loanId, input.borrower)
  ) {
    throw new AppError("EscrowFinish hors scope du grant", 403);
  }
}
