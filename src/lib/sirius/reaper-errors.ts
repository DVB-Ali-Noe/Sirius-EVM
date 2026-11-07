import { AppError } from "@/lib/app-error";
import { SETTLEMENT_QUEUED } from "@/lib/loans/settlement-status";
import { RUNNER_WALLET_BUSY, RunnerFinalityPending } from "@/lib/runner/failure-policy";

/**
 * Une passe ne compte comme échouée que pour une vraie erreur. Deux attentes normales n'en sont
 * pas : la finalité d'un règlement déjà diffusé, et le wallet du runner occupé par un autre
 * règlement (une transaction en vol à la fois, audit PAR-02 ; environ 20 min de finalité sur
 * Robinhood Chain). Les compter faisait passer le battement du reaper en alerte sans raison.
 */
export function reaperErrorKind(error: unknown): "pending" | "busy" | "failed" {
  if (error instanceof RunnerFinalityPending) return "pending";
  if (error instanceof AppError && error.status === 503
    && (error.message === RUNNER_WALLET_BUSY || error.message === SETTLEMENT_QUEUED)) return "busy";
  return "failed";
}
