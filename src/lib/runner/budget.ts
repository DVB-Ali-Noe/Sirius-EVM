import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import { BudgetLedger, type BudgetKind } from "./budget-ledger";

let cached: { path: string; chainId: number; wallet: string; ledger: BudgetLedger } | undefined;

export function runnerBudget(): BudgetLedger | null {
  const path = process.env.RUNNER_BUDGET_FILE;
  if (cached && !path) throw new AppError("Changement du registre runner interdit à chaud", 503);
  if (!path) {
    if (process.env.NODE_ENV === "production" || process.env.TEE_MODE === "phala" || process.env.EVM_NETWORK === "mainnet") {
      throw new AppError("RUNNER_BUDGET_FILE obligatoire avant toute opération runner", 503);
    }
    return null;
  }
  const { chainId } = evmEscrowBinding();
  const wallet = process.env.SIRIUS_LOCK_AUTHORIZER?.toLowerCase();
  if (!wallet) throw new AppError("Identité du wallet requise pour le budget runner", 503);
  if (cached && (cached.path !== path || cached.chainId !== chainId || cached.wallet !== wallet)) {
    throw new AppError("Changement du registre runner interdit à chaud", 503);
  }
  if (!cached) {
    try { cached = { path, chainId, wallet, ledger: new BudgetLedger(path, chainId, wallet) }; }
    catch { throw new AppError("Registre de budget runner indisponible", 503); }
  }
  return cached.ledger;
}

export function budgetFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
    }
    return item;
  })).digest("hex");
}

export async function runBudgetedOperation<T>(
  ledger: BudgetLedger | null,
  kind: Exclude<BudgetKind, "transaction">,
  id: string,
  fingerprint: string,
  action: () => Promise<T>,
): Promise<T> {
  if (!ledger) return action();
  const reservation = ledger.reserve(id, fingerprint, kind);
  if (!reservation.fresh) {
    if (reservation.operation.state === "succeeded" && reservation.operation.result !== null) {
      return JSON.parse(reservation.operation.result) as T;
    }
    throw new AppError("Opération runner déjà engagée : réconciliation requise", 503);
  }
  try {
    const result = await action();
    ledger.finish(id, fingerprint, true, kind === "request" ? null : JSON.stringify(result));
    return result;
  } catch (error) {
    ledger.finish(id, fingerprint, false);
    throw error;
  }
}

export function budgetRunnerRequest<T>(action: () => Promise<T>): Promise<T> {
  return runBudgetedOperation(runnerBudget(), "request", `request:${randomUUID()}`, "request-v1", action);
}

export function budgetRunnerJob<T>(kind: "seal" | "training", scope: unknown, input: unknown, action: () => Promise<T>): Promise<T> {
  return runBudgetedOperation(runnerBudget(), kind, `${kind}:${budgetFingerprint(scope)}`, budgetFingerprint(input), action);
}
