/**
 * Message partagé entre la route de règlement et l'interface : la transaction est partie,
 * le réseau ne l'a pas encore finalisée. Sur mainnet, compter de quinze à trente minutes.
 */
export const SETTLEMENT_FINALITY_PENDING = "Règlement envoyé : le réseau le confirme en général sous 15 à 30 minutes. Reviens ensuite pour récupérer ton modèle.";

/** Même attente pour un prêt au palier rapide (fast-finality.ts) : quelques dizaines de confirmations L2. */
export const SETTLEMENT_FINALITY_PENDING_FAST = "Règlement envoyé : le réseau le confirme en général sous une minute. Reviens ensuite pour récupérer ton modèle.";

/** Une attente de règlement n'est pas un échec : la page l'affiche en information, pas en erreur. */
export function isSettlementPending(message: string): boolean {
  return message === SETTLEMENT_FINALITY_PENDING || message === SETTLEMENT_FINALITY_PENDING_FAST;
}

/**
 * Refus de `POST /api/loans/[id]/settle` (503) quand un autre règlement occupe le wallet unique du
 * runner (audit PAR-02). Rien n'est perdu : le prêt revient en attente de règlement, l'interface
 * réessaie seule quelques secondes plus tard, et le reaper le reprend aussi (prêts v7).
 */
export const SETTLEMENT_QUEUED = "Un autre règlement est en cours sur le runner : réessaie dans un instant, le tien sera aussi repris automatiquement";

/**
 * Refus de `POST /api/loans/[id]/run` (409) tant que le lock n'est pas sous le bloc stable
 * (`assertBlockStable` dans `prepareLoanResult`). La page Train le reconnaît pour passer en
 * attente de finalité au lieu d'afficher une erreur.
 */
export const LOCK_FINALITY_PENDING = "Paiement en attente de finalité du réseau : l’entraînement pourra démarrer dans quelques minutes";
