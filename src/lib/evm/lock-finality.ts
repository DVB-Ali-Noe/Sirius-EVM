/**
 * Attente de finalité d'un lock de paiement : estimation partagée entre la route
 * `GET /api/loans/[id]/finality` et la page Train. Fonctions pures, sans accès réseau.
 *
 * Sur Robinhood Chain (Arbitrum Nitro), le bloc `finalized` suit la finalité L1 et reste
 * environ un quart d'heure derrière la tête (docs/passage-mainnet/19-mise-en-production.md :
 * ≈ 8 500 blocs, 14 min, relevé du 5 octobre ; docs/MAINNET-RUNBOOKS.md : « environ
 * 16 minutes »). `prepareLoanResult` refuse l'entraînement tant que le bloc stable n'a pas
 * atteint le bloc de lock (`assertBlockStable`). Plutôt qu'une constante qui vieillirait,
 * l'estimation lit la chaîne : le pointeur stable avance au rythme de l'horloge, donc le temps
 * qu'il atteigne le bloc de lock vaut à peu près l'écart entre l'horodatage du lock et celui
 * du bloc stable courant. En mode `confirmations` (testnet), cet écart se compte en secondes.
 */

export interface LockFinalityObservation {
  lockBlock: bigint;
  /** Horodatage du bloc de lock, en secondes (champ `timestamp` du bloc). */
  lockTimestamp: bigint;
  /** Bloc stable courant (`confirmedBlock`) et son horodatage en secondes. */
  stableBlock: bigint;
  stableTimestamp: bigint;
}

export interface LockFinalityEstimate {
  pending: boolean;
  /** Instant estimé (ms epoch) où le lock passera sous le bloc stable ; `now` s'il l'est déjà. */
  estimatedReadyAt: number;
}

export function estimateLockFinality(observation: LockFinalityObservation, now = Date.now()): LockFinalityEstimate {
  if (observation.stableBlock >= observation.lockBlock) return { pending: false, estimatedReadyAt: now };
  const gapMs = Number(observation.lockTimestamp - observation.stableTimestamp) * 1_000;
  return { pending: true, estimatedReadyAt: now + Math.max(0, gapMs) };
}

/** Minutes restantes affichées, arrondies au supérieur ; 0 dès que l'estimation est dépassée. */
export function lockFinalityMinutesLeft(estimatedReadyAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((estimatedReadyAt - now) / 60_000));
}

/** Relecture au plus tôt 20 s, au plus tard 60 s après la précédente : jamais de rafale RPC. */
export const LOCK_FINALITY_POLL_MIN_MS = 20_000;
export const LOCK_FINALITY_POLL_MAX_MS = 60_000;

/**
 * Délai avant la prochaine lecture de `/api/loans/[id]/finality` : à l'instant estimé, borné
 * entre les deux limites ci-dessus. Une estimation dépassée relit donc toutes les 20 s.
 */
export function nextLockFinalityCheckMs(estimatedReadyAt: number, now = Date.now()): number {
  return Math.min(LOCK_FINALITY_POLL_MAX_MS, Math.max(LOCK_FINALITY_POLL_MIN_MS, estimatedReadyAt - now));
}

export interface LockFinalityResponse {
  pending: boolean;
  /** ISO 8601 quand `pending` ; `null` sinon. */
  estimatedReadyAt: string | null;
}

/** Lecture défensive de la réponse : tout corps inattendu vaut « pas en attente ». */
export function parseLockFinalityResponse(body: unknown): { pending: boolean; estimatedReadyAt: number | null } {
  if (!body || typeof body !== "object" || (body as { pending?: unknown }).pending !== true) {
    return { pending: false, estimatedReadyAt: null };
  }
  const raw = (body as { estimatedReadyAt?: unknown }).estimatedReadyAt;
  const parsed = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  return { pending: true, estimatedReadyAt: Number.isFinite(parsed) ? parsed : null };
}
