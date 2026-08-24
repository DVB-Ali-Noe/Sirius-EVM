import "server-only";
import { prisma } from "@/lib/db";
import { reconcileLoanEscrowInRunner } from "@/lib/tee/runner-client";
import { reconcileEscrowCreate } from "@/lib/xrpl/escrow";
import {
  CHAIN_REAPER_LEASE_MS,
  loanReaperAction,
  PENDING_REAPER_TTL_MS,
  SETTLEMENT_REAPER_LEASE_MS,
  SUBMISSION_REAPER_LEASE_MS,
  TRAINING_REAPER_LEASE_MS,
} from "./reaper-policy";

const REAPER_BATCH_SIZE = 50;

type ReaperLoan = Awaited<ReturnType<typeof findCandidates>>[number];

function findCandidates(now: Date) {
  return prisma.loan.findMany({
    where: {
      OR: [
        {
          status: "PENDING",
          createdAt: { lte: new Date(now.getTime() - PENDING_REAPER_TTL_MS) },
        },
        {
          status: "SUBMITTING",
          updatedAt: { lte: new Date(now.getTime() - SUBMISSION_REAPER_LEASE_MS) },
        },
        {
          status: "ESCROWED",
          cancelAfter: { lte: now },
          updatedAt: { lte: new Date(now.getTime() - CHAIN_REAPER_LEASE_MS) },
        },
        {
          status: "TRAINING",
          OR: [
            {
              cancelAfter: { lte: now },
              updatedAt: { lte: new Date(now.getTime() - CHAIN_REAPER_LEASE_MS) },
            },
            {
              modelCid: null,
              updatedAt: { lte: new Date(now.getTime() - TRAINING_REAPER_LEASE_MS) },
            },
          ],
        },
        {
          status: "SETTLING",
          updatedAt: {
            lte: new Date(now.getTime() - Math.min(CHAIN_REAPER_LEASE_MS, SETTLEMENT_REAPER_LEASE_MS)),
          },
        },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: REAPER_BATCH_SIZE,
    select: {
      id: true,
      borrower: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      cancelAfter: true,
      escrowTxHash: true,
      escrowTxBlob: true,
      escrowLastLedger: true,
      escrowSequence: true,
      modelCid: true,
      attestationHash: true,
      runnerReceipt: true,
    },
  });
}

async function claim(loan: ReaperLoan, now: Date): Promise<boolean> {
  const result = await prisma.loan.updateMany({
    where: { id: loan.id, status: loan.status, updatedAt: loan.updatedAt },
    data: { updatedAt: now },
  });
  return result.count === 1;
}

async function reconcileSubmission(loan: ReaperLoan, now: Date): Promise<void> {
  if (!(await claim(loan, now))) return;
  if (!loan.escrowTxHash || loan.escrowLastLedger == null) {
    await prisma.loan.updateMany({
      where: { id: loan.id, status: "SUBMITTING", updatedAt: now },
      data: { status: "CANCELLED", escrowTxBlob: null },
    });
    return;
  }
  const state = await reconcileEscrowCreate(loan.escrowTxHash, loan.escrowLastLedger);
  if (state === "pending") return;
  await prisma.loan.updateMany({
    where: {
      id: loan.id,
      status: "SUBMITTING",
      updatedAt: now,
      escrowTxHash: loan.escrowTxHash,
    },
    data: {
      status: state === "confirmed" ? "ESCROWED" : "CANCELLED",
      escrowTxBlob: null,
    },
  });
}

async function resetTraining(loan: ReaperLoan, now: Date): Promise<void> {
  if (!(await claim(loan, now))) return;
  await prisma.loan.updateMany({
    where: { id: loan.id, status: "TRAINING", modelCid: null, updatedAt: now },
    data: { status: "ESCROWED" },
  });
}

async function reconcileChain(loan: ReaperLoan, now: Date): Promise<void> {
  if (!loan.escrowTxHash || loan.escrowSequence == null) {
    throw new Error("référence EscrowCreate absente");
  }
  if (!(await claim(loan, now))) return;
  const result = await reconcileLoanEscrowInRunner({
    loanId: loan.id,
    borrower: loan.borrower,
    escrowTxHash: loan.escrowTxHash,
    escrowSequence: loan.escrowSequence,
    ...(loan.runnerReceipt ? { loanReceipt: loan.runnerReceipt } : {}),
  });
  if (result.state === "active") return;
  await prisma.loan.updateMany({
    where: { id: loan.id, status: loan.status, updatedAt: now },
    data: result.state === "settled"
      ? { status: "SETTLED", settleTxHash: result.txHash, settledAt: new Date() }
      : { status: "CANCELLED", cancelTxHash: result.txHash },
  });
}

export async function runLoanReaper(now = new Date()): Promise<void> {
  const loans = await findCandidates(now);
  for (const loan of loans) {
    const action = loanReaperAction(loan, now);
    if (!action) continue;
    try {
      if (action === "cancel-pending") {
        await prisma.loan.updateMany({
          where: { id: loan.id, status: "PENDING", updatedAt: loan.updatedAt },
          data: { status: "CANCELLED" },
        });
      } else if (action === "reconcile-submission") {
        await reconcileSubmission(loan, now);
      } else if (action === "reset-training") {
        await resetTraining(loan, now);
      } else {
        await reconcileChain(loan, now);
      }
    } catch (error) {
      console.error(`[reaper] prêt ${loan.id} non réconcilié`, error);
    }
  }
}

interface ReaperRuntime {
  running: boolean;
  timer: NodeJS.Timeout;
}

const globalForReaper = globalThis as typeof globalThis & {
  __siriusLoanReaper?: ReaperRuntime;
};

function intervalMs(): number {
  const value = Number(process.env.SIRIUS_REAPER_INTERVAL_MS ?? 30_000);
  if (!Number.isSafeInteger(value) || value < 10_000 || value > 600_000) {
    throw new Error("SIRIUS_REAPER_INTERVAL_MS doit être compris entre 10000 et 600000");
  }
  return value;
}

export function startLoanReaper(): void {
  if (process.env.SIRIUS_REAPER_ENABLED !== "true" || globalForReaper.__siriusLoanReaper) return;
  const runtime = { running: false } as ReaperRuntime;
  const tick = async () => {
    if (runtime.running) return;
    runtime.running = true;
    try {
      await runLoanReaper();
    } catch (error) {
      console.error("[reaper] cycle impossible", error);
    } finally {
      runtime.running = false;
    }
  };
  runtime.timer = setInterval(() => void tick(), intervalMs());
  runtime.timer.unref();
  globalForReaper.__siriusLoanReaper = runtime;
  void tick();
}
