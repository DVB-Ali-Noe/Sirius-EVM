import "server-only";
import { prisma } from "@/lib/db";
import { reconcileLoanEscrow } from "@/lib/evm/escrow";
import {
  CHAIN_REAPER_LEASE_MS,
  PENDING_REAPER_TTL_MS,
  SETTLEMENT_REAPER_LEASE_MS,
  TRAINING_REAPER_LEASE_MS,
} from "./reaper-policy";

const BATCH_SIZE = 50;
let timer: ReturnType<typeof setInterval> | null = null;

export function startLoanReaper(): void {
  if (timer) return;
  const interval = Number(process.env.SIRIUS_REAPER_INTERVAL_MS ?? 30_000);
  if (!Number.isSafeInteger(interval) || interval < 5_000 || interval > 300_000) {
    throw new Error("SIRIUS_REAPER_INTERVAL_MS invalide");
  }
  timer = setInterval(() => void runLoanReaper(), interval);
  timer.unref?.();
  void runLoanReaper();
}

export async function runLoanReaper(now = new Date()): Promise<void> {
  const loans = await prisma.loan.findMany({
    where: {
      OR: [
        { status: "PENDING", createdAt: { lte: new Date(now.getTime() - PENDING_REAPER_TTL_MS) } },
        { status: "TRAINING", modelCid: null, updatedAt: { lte: new Date(now.getTime() - TRAINING_REAPER_LEASE_MS) } },
        { status: "SETTLING", updatedAt: { lte: new Date(now.getTime() - SETTLEMENT_REAPER_LEASE_MS) } },
        { status: { in: ["ESCROWED", "TRAINING", "SETTLING"] }, updatedAt: { lte: new Date(now.getTime() - CHAIN_REAPER_LEASE_MS) } },
      ],
    },
    select: { id: true, status: true, evmLoanKey: true, evmLockBlock: true, modelCid: true, updatedAt: true },
    orderBy: { updatedAt: "asc" },
    take: BATCH_SIZE,
  });
  for (const loan of loans) {
    try {
      if (loan.status === "PENDING") {
        await prisma.loan.updateMany({ where: { id: loan.id, status: "PENDING", updatedAt: loan.updatedAt }, data: { status: "CANCELLED" } });
        continue;
      }
      if (loan.status === "TRAINING" && !loan.modelCid) {
        await prisma.loan.updateMany({ where: { id: loan.id, status: "TRAINING", updatedAt: loan.updatedAt }, data: { status: "ESCROWED" } });
        continue;
      }
      if (!loan.evmLoanKey || !loan.evmLockBlock) continue;
      const state = await reconcileLoanEscrow(loan.evmLoanKey as `0x${string}`, BigInt(loan.evmLockBlock));
      if (state.state === "active") continue;
      await prisma.loan.updateMany({
        where: { id: loan.id, status: loan.status, updatedAt: loan.updatedAt },
        data: state.state === "settled"
          ? { status: "SETTLED", settleTxHash: state.txHash, settledAt: new Date() }
          : { status: "CANCELLED", cancelTxHash: state.txHash },
      });
    } catch (error) {
      console.error(`[reaper] prêt EVM ${loan.id} non réconcilié`, error);
    }
  }
}
