import { AppError } from "@/lib/app-error";
import { SETTLEMENT_QUEUED } from "@/lib/loans/settlement-status";
import { RUNNER_WALLET_BUSY } from "@/lib/runner/failure-policy";

/**
 * Côté Next seulement (route de règlement) : `RUNNER_WALLET_BUSY` revient de l'enclave en 503 et
 * devient `SETTLEMENT_QUEUED`, que l'interface reconnaît pour relancer seule (audit PAR-02) ;
 * toute autre erreur passe telle quelle. Hors de `failure-policy.ts`, que le runner embarque :
 * ses CLI n'ont pas à charger les messages de l'interface.
 */
export function settlementQueuedError(error: unknown): unknown {
  return error instanceof AppError && error.status === 503 && error.message === RUNNER_WALLET_BUSY
    ? new AppError(SETTLEMENT_QUEUED, 503)
    : error;
}
