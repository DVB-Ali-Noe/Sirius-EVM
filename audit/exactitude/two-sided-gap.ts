/**
 * Q4 : contrôle à deux sens de l'écart entre AUC d'entraînement et AUC held-out (proposition d'audit, hors production).
 *
 * Le contrôle actuel (`train-gbdt.test.ts:90`, test unitaire seulement) n'a qu'un sens :
 * `trainAuc >= heldOutAuc - 0.02`. Il attrape un held-out « trop beau » (fuite, split inversé), pas une
 * mémorisation (train ≫ held-out), et sa marge fixe ne tient pas compte de la taille du held-out.
 *
 * Proposition : marges en erreurs types de l'AUC held-out (Hanley et McNeil, 1982).
 * - Sens 1, held-out trop beau : heldOutAuc − trainAuc > 3·SE.
 * - Sens 2, mémorisation : trainAuc − heldOutAuc > 0,02 + 3·SE (0,02 absorbe l'optimisme normal du train).
 */

export const GAP_SIGMAS = 3;
export const MEMORIZATION_MARGIN = 0.02;

export function aucStandardError(auc: number, positives: number, negatives: number): number {
  const q1 = auc / (2 - auc);
  const q2 = (2 * auc * auc) / (1 + auc);
  const variance = (auc * (1 - auc) + (positives - 1) * (q1 - auc * auc) + (negatives - 1) * (q2 - auc * auc)) / (positives * negatives);
  return Math.sqrt(Math.max(variance, 0));
}

export type GapVerdict = "ok" | "held_out_too_good" | "memorization";

export function twoSidedGapCheck(trainAuc: number, heldOutAuc: number, positives: number, negatives: number): { verdict: GapVerdict; se: number } {
  const se = aucStandardError(heldOutAuc, positives, negatives);
  if (heldOutAuc - trainAuc > GAP_SIGMAS * se) return { verdict: "held_out_too_good", se };
  if (trainAuc - heldOutAuc > MEMORIZATION_MARGIN + GAP_SIGMAS * se) return { verdict: "memorization", se };
  return { verdict: "ok", se };
}

export function currentOneSidedCheck(trainAuc: number, heldOutAuc: number): boolean {
  return trainAuc >= heldOutAuc - 0.02;
}

/**
 * Le modèle livré ne donne pas le nombre de défauts du held-out ; on le retrouve à partir de n, accuracy,
 * précision et rappel (held-out = floor(n / 5) lignes). Sert au navigateur, sans changer le format livré.
 */
export function heldOutClassCounts(n: number, accuracy: number, precision: number, recall: number): { positives: number; negatives: number } | null {
  const rows = Math.floor(n / 5);
  if (precision <= 0 || recall <= 0) return null;
  const positives = Math.round((rows * (1 - accuracy)) / (1 + (recall * (1 - precision)) / precision - recall));
  if (!(positives > 0 && positives < rows)) return null;
  return { positives, negatives: rows - positives };
}
