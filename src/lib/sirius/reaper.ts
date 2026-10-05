import "server-only";
import type { Loan } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { reconcileLoanEscrow } from "@/lib/evm/escrow";
import {
  CHAIN_REAPER_LEASE_MS,
  PENDING_REAPER_TTL_MS,
  SETTLEMENT_REAPER_LEASE_MS,
  SUBMISSION_REAPER_LEASE_MS,
  TRAINING_REAPER_LEASE_MS,
} from "./reaper-policy";
import { recoverUnsubmittedLoan } from "./recover-loan";
import { resolveLoanEscrow } from "@/lib/evm/history";
import { recoverLoanResult, settlePreparedLoan } from "./settle";
import { RunnerFinalityPending } from "@/lib/runner/failure-policy";

const BATCH_SIZE = 50;
let timer: ReturnType<typeof setInterval> | null = null;
let afterId: string | null = null;
let running: Promise<ReaperPassResult> | null = null;

/** Bilan d'une passe : prêts examinés et prêts restés en erreur (hors attente de finalité). */
export type ReaperPassResult = { examined: number; failed: number };

export function startLoanReaper(): void {
  if (timer) return;
  const interval = Number(process.env.SIRIUS_REAPER_INTERVAL_MS ?? 30_000);
  if (!Number.isSafeInteger(interval) || interval < 5_000 || interval > 300_000) {
    throw new Error("SIRIUS_REAPER_INTERVAL_MS invalide");
  }
  const run = () => { void runLoanReaper().catch(() => console.error("[reaper] passe indisponible, reprise à la suivante")); };
  timer = setInterval(run, interval);
  timer.unref?.();
  run();
}

export function runLoanReaper(now = new Date()): Promise<ReaperPassResult> {
  if (!running) running = reapBatch(now).finally(() => { running = null; });
  return running;
}

async function reapBatch(now: Date): Promise<ReaperPassResult> {
  const loans = await prisma.loan.findMany({
    where: {
      ...(afterId ? { id: { gt: afterId } } : {}),
      OR: [
        { status: "PENDING", createdAt: { lte: new Date(now.getTime() - PENDING_REAPER_TTL_MS) } },
        { status: "SUBMITTING", updatedAt: { lte: new Date(now.getTime() - SUBMISSION_REAPER_LEASE_MS) } },
        { status: "CANCELLED", cancelTxHash: null, evmLoanKey: { not: null } },
        { status: "TRAINING", modelCid: null, updatedAt: { lte: new Date(now.getTime() - TRAINING_REAPER_LEASE_MS) } },
        { status: "SETTLING", updatedAt: { lte: new Date(now.getTime() - SETTLEMENT_REAPER_LEASE_MS) } },
        { status: { in: ["ESCROWED", "TRAINING", "SETTLING"] }, updatedAt: { lte: new Date(now.getTime() - CHAIN_REAPER_LEASE_MS) } },
      ],
    },
    orderBy: { id: "asc" },
    take: BATCH_SIZE,
  });
  // Le curseur avance aussi quand un prêt est actif ou son RPC échoue.
  afterId = loans.length === BATCH_SIZE ? loans.at(-1)!.id : null;
  let failed = 0;
  for (const loan of loans) {
    try {
      if (loan.status === "PENDING" || loan.status === "SUBMITTING" || loan.status === "CANCELLED") {
        await recoverUnsubmittedLoan(loan);
        continue;
      }
      if (loan.billingQuoteHash && await reconcileClosedLoan(loan)) continue;
      if (!loan.modelCid && loan.billingQuoteHash) {
        if (await recoverLoanResult(loan.id)) {
          await settlePreparedLoan(loan.id);
          continue;
        }
      } else if (loan.status === "TRAINING" && !loan.modelCid) {
        await prisma.loan.updateMany({ where: { id: loan.id, status: "TRAINING", updatedAt: loan.updatedAt }, data: { status: "ESCROWED" } });
        continue;
      }
      if ((loan.status === "TRAINING" || loan.status === "SETTLING") && loan.modelCid && loan.billingQuoteHash) {
        await settlePreparedLoan(loan.id);
        continue;
      }
      if (!loan.billingQuoteHash) await reconcileClosedLoan(loan);
    } catch (error) {
      if (error instanceof RunnerFinalityPending) console.log(`[reaper] prêt EVM ${loan.id} : règlement en attente de finalité`);
      else {
        failed += 1;
        console.error(`[reaper] prêt EVM ${loan.id} non réconcilié`);
      }
    }
  }
  return { examined: loans.length, failed };
}

async function reconcileClosedLoan(loan: Loan): Promise<boolean> {
  if (!loan.evmLoanKey || !loan.evmLockBlock) return false;
  const state = await reconcileLoanEscrow(loan.evmLoanKey as `0x${string}`, BigInt(loan.evmLockBlock), await resolveLoanEscrow(loan));
  if (state.state === "active") return false;
  // La reprise du résultat et la validation de sa preuve précèdent toujours le règlement v7.
  if (state.state === "settled" && loan.billingQuoteHash) return false;
  await prisma.loan.updateMany({
    where: { id: loan.id, status: loan.status, updatedAt: loan.updatedAt },
    data: state.state === "settled"
      ? { status: "SETTLED", settleTxHash: state.txHash, settledAt: new Date() }
      : { status: "CANCELLED", cancelTxHash: state.txHash,
        ...(state.retainedFee !== undefined ? { retainedFeeUsdcAtomic: state.retainedFee, refundAmountUsdcAtomic: state.refundAmount } : {}) },
  });
  return true;
}
