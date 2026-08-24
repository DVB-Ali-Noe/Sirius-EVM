import "server-only";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { reconcileLoanEscrowInRunner } from "@/lib/tee/runner-client";

const ACTIVE_ESCROW_STATUSES = ["ESCROWED", "TRAINING", "SETTLING"] as const;

export async function cancelExpiredLoan(loanId: string, borrower: string) {
  const loan = await prisma.loan.findFirst({
    where: { id: loanId, borrower },
    select: {
      id: true,
      status: true,
      borrower: true,
      cancelAfter: true,
      cancelTxHash: true,
      escrowTxHash: true,
      escrowSequence: true,
      runnerReceipt: true,
    },
  });
  if (!loan) throw new AppError("Loan introuvable", 404);
  if (loan.status === "CANCELLED") {
    return { loanId, status: loan.status, cancelTxHash: loan.cancelTxHash };
  }
  if (loan.status === "SETTLED") throw new AppError("Escrow déjà réglé", 409);
  if (!(ACTIVE_ESCROW_STATUSES as readonly string[]).includes(loan.status)) {
    throw new AppError("Escrow non remboursable", 409);
  }
  if (!loan.cancelAfter || loan.cancelAfter.getTime() > Date.now()) {
    throw new AppError("CancelAfter n’est pas encore atteint", 409);
  }
  if (!loan.escrowTxHash || loan.escrowSequence == null) {
    throw new AppError("Référence EscrowCreate absente", 409);
  }

  const result = await reconcileLoanEscrowInRunner({
    loanId,
    borrower,
    escrowTxHash: loan.escrowTxHash,
    escrowSequence: loan.escrowSequence,
    ...(loan.runnerReceipt ? { loanReceipt: loan.runnerReceipt } : {}),
  });
  if (result.state === "active") {
    throw new AppError("CancelAfter n’est pas encore atteint sur le ledger validé", 409);
  }

  const status = result.state === "settled" ? "SETTLED" : "CANCELLED";
  const updated = await prisma.loan.updateMany({
    where: { id: loanId, borrower, status: { in: [...ACTIVE_ESCROW_STATUSES] } },
    data: result.state === "settled"
      ? { status, settleTxHash: result.txHash, settledAt: new Date() }
      : { status, cancelTxHash: result.txHash },
  });
  if (updated.count === 0) {
    const current = await prisma.loan.findUnique({
      where: { id: loanId },
      select: { status: true, cancelTxHash: true, settleTxHash: true },
    });
    if (current?.status === "CANCELLED") {
      return { loanId, status: current.status, cancelTxHash: current.cancelTxHash };
    }
    if (current?.status === "SETTLED") throw new AppError("Escrow déjà réglé", 409);
    throw new AppError("État local du prêt incohérent", 409);
  }
  if (status === "SETTLED") throw new AppError("Escrow déjà réglé", 409);
  return { loanId, status, cancelTxHash: result.txHash };
}
