import "server-only";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { addressesEqual } from "@/lib/evm/address";
import { readLoan, reconcileLoanEscrow, refundEscrow } from "@/lib/evm/escrow";

const ACTIVE = ["ESCROWED", "TRAINING", "SETTLING"] as const;

export async function cancelExpiredLoan(loanId: string, borrower: string) {
  const loan = await prisma.loan.findUnique({ where: { id: loanId } });
  if (!loan || !addressesEqual(loan.borrower, borrower)) throw new AppError("Loan introuvable", 404);
  if (loan.status === "CANCELLED") return { loanId, status: loan.status, cancelTxHash: loan.cancelTxHash };
  if (loan.status === "SETTLED") throw new AppError("Escrow USDC déjà réglé", 409);
  if (!(ACTIVE as readonly string[]).includes(loan.status) || !loan.evmLoanKey) throw new AppError("Escrow USDC non remboursable", 409);

  const onChain = await readLoan(loan.evmLoanKey as `0x${string}`);
  if (!onChain || onChain.deadline * 1000 > Date.now()) throw new AppError("Échéance USDC non atteinte", 409);
  if (!loan.evmLockBlock) throw new AppError("Bloc de lock USDC absent", 409);
  const lockBlock = BigInt(loan.evmLockBlock);
  const resolution = await reconcileLoanEscrow(loan.evmLoanKey as `0x${string}`, lockBlock);
  if (resolution.state === "settled") throw new AppError("Escrow USDC déjà réglé", 409);
  const txHash = resolution.state === "cancelled" ? resolution.txHash : await refundEscrow(loan.evmLoanKey as `0x${string}`, lockBlock);
  await prisma.loan.updateMany({
    where: { id: loanId, borrower: loan.borrower, status: { in: [...ACTIVE] } },
    data: { status: "CANCELLED", cancelTxHash: txHash },
  });
  return { loanId, status: "CANCELLED", cancelTxHash: txHash };
}
