/**
 * Contrôle à deux sens de l'écart entre AUC d'entraînement et AUC held-out des arbres boostés
 * (audit EXA-01). Module pur : sert au test de l'entraînement et à la page Train, sans changer
 * le format du modèle livré.
 *
 * L'ancien contrôle (`trainAuc >= heldOutAuc - 0.02`, test seulement) n'avait qu'un sens et une
 * marge fixe : il laissait passer une mémorisation (train 0,998 / held-out 0,754) et un held-out
 * corrompu, et alertait à tort quand le held-out était meilleur par pur hasard. Les marges sont ici
 * en erreurs types de l'AUC held-out (Hanley et McNeil, 1982), donc suivent la taille du held-out :
 * - held-out trop beau (fuite, split inversé, erreur de lignes) : heldOutAuc − trainAuc > 3·SE ;
 * - mémorisation : trainAuc − heldOutAuc > 0,02 + 3·SE (0,02 absorbe l'optimisme normal du train).
 *
 * Mesuré sur 36 tirages légitimes (credit-risk, Taïwan, GMSC) : aucune fausse alerte ; 3
 * mémorisations sur 3 et le held-out corrompu sont signalés.
 */
import { GBDT_HOLDOUT_EVERY } from "./gbdt";

export const GAP_SIGMAS = 3;
export const MEMORIZATION_MARGIN = 0.02;

export type GapVerdict = "ok" | "held_out_too_good" | "memorization";

/** Erreur type de Hanley et McNeil pour une AUC mesurée sur `positives` et `negatives` lignes. */
export function aucStandardError(auc: number, positives: number, negatives: number): number {
  const q1 = auc / (2 - auc);
  const q2 = (2 * auc * auc) / (1 + auc);
  const variance = (auc * (1 - auc) + (positives - 1) * (q1 - auc * auc) + (negatives - 1) * (q2 - auc * auc)) / (positives * negatives);
  return Math.sqrt(Math.max(variance, 0));
}

export function twoSidedGapCheck(trainAuc: number, heldOutAuc: number, positives: number, negatives: number): { verdict: GapVerdict; se: number } {
  const se = aucStandardError(heldOutAuc, positives, negatives);
  if (heldOutAuc - trainAuc > GAP_SIGMAS * se) return { verdict: "held_out_too_good", se };
  if (trainAuc - heldOutAuc > MEMORIZATION_MARGIN + GAP_SIGMAS * se) return { verdict: "memorization", se };
  return { verdict: "ok", se };
}

/**
 * Le modèle livré ne donne pas le nombre de défauts du held-out ; on le retrouve à partir de n,
 * accuracy, précision et rappel (held-out = floor(n / 5) lignes). `null` si les métriques ne le
 * permettent pas (précision ou rappel nuls, effectif incohérent).
 */
export function heldOutClassCounts(n: number, accuracy: number, precision: number, recall: number): { positives: number; negatives: number } | null {
  const rows = Math.floor(n / GBDT_HOLDOUT_EVERY);
  if (precision <= 0 || recall <= 0) return null;
  const positives = Math.round((rows * (1 - accuracy)) / (1 + (recall * (1 - precision)) / precision - recall));
  if (!(positives > 0 && positives < rows)) return null;
  return { positives, negatives: rows - positives };
}

/** Verdict depuis les seules métriques livrées ; `null` quand l'effectif held-out ne se retrouve pas. */
export function gbdtGapVerdict(metrics: {
  trainAuc: number; heldOutAuc: number; heldOutAccuracy: number; heldOutPrecision: number; heldOutRecall: number; n: number;
}): GapVerdict | null {
  const counts = heldOutClassCounts(metrics.n, metrics.heldOutAccuracy, metrics.heldOutPrecision, metrics.heldOutRecall);
  if (!counts) return null;
  return twoSidedGapCheck(metrics.trainAuc, metrics.heldOutAuc, counts.positives, counts.negatives).verdict;
}

export const GAP_WARNINGS: Record<Exclude<GapVerdict, "ok">, string> = {
  held_out_too_good: "Écart anormal : l’AUC held-out dépasse l’AUC d’entraînement au-delà de l’aléa (3 erreurs types). Vérifie l’ordre des lignes et l’absence de fuite de la cible.",
  memorization: "Écart anormal : l’AUC d’entraînement dépasse l’AUC held-out de plus de 0,02 + 3 erreurs types. Le modèle mémorise peut-être ses lignes d’entraînement : fie-toi aux métriques held-out.",
};
