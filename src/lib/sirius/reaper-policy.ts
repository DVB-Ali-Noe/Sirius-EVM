export const PENDING_REAPER_TTL_MS = 10 * 60_000;
export const SUBMISSION_REAPER_LEASE_MS = 30_000;
export const TRAINING_REAPER_LEASE_MS = 90_000;
export const SETTLEMENT_REAPER_LEASE_MS = 90_000;
export const CHAIN_REAPER_LEASE_MS = 90_000;

export type LoanReaperAction =
  | "cancel-pending"
  | "reconcile-submission"
  | "reset-training"
  | "reconcile-chain";

export interface LoanReaperSnapshot {
  status: "PENDING" | "SUBMITTING" | "ESCROWED" | "TRAINING" | "SETTLING" | "SETTLED" | "CANCELLED";
  createdAt: Date;
  updatedAt: Date;
  cancelAfter: Date | null;
  modelCid: string | null;
}

export function loanReaperAction(
  loan: LoanReaperSnapshot,
  now: Date,
): LoanReaperAction | null {
  const age = now.getTime() - loan.updatedAt.getTime();
  if (loan.status === "PENDING") {
    return now.getTime() - loan.createdAt.getTime() >= PENDING_REAPER_TTL_MS
      ? "cancel-pending"
      : null;
  }
  if (loan.status === "SUBMITTING") {
    return age >= SUBMISSION_REAPER_LEASE_MS ? "reconcile-submission" : null;
  }
  if (
    (loan.status === "ESCROWED" || loan.status === "TRAINING" || loan.status === "SETTLING") &&
    loan.cancelAfter &&
    loan.cancelAfter.getTime() <= now.getTime() &&
    age >= CHAIN_REAPER_LEASE_MS
  ) {
    return "reconcile-chain";
  }
  if (loan.status === "TRAINING" && !loan.modelCid && age >= TRAINING_REAPER_LEASE_MS) {
    return "reset-training";
  }
  if (loan.status === "SETTLING" && age >= SETTLEMENT_REAPER_LEASE_MS) {
    return "reconcile-chain";
  }
  return null;
}
