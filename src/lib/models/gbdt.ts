/**
 * Profil « gradient_boosted_trees » v1 : arbres boostés stricts pour une cible binaire 0/1.
 *
 * Module pur, partagé par l'enclave (entraînement, porte de sortie), le navigateur (contrôle
 * du CSV, évaluation, prédiction) et la validation des modèles livrés. Les constantes du
 * profil sont la source unique : les modifier change le profil et impose une nouvelle version.
 *
 * Réglage « strict » des essais model-zoo (profondeur 2, feuilles d'au moins 1 000 lignes) :
 * sur données réelles, c'est le seul qui ramène la fuite des records atypiques au niveau du
 * hasard. 150 arbres à 0,1 plutôt que 300 à 0,05 : même AUC held-out sur Taïwan (0,787),
 * moitié moins de calcul et de sortie. Aucun tirage aléatoire : même fichier, même modèle.
 */

export const GBDT_TREES = 150;
export const GBDT_MAX_DEPTH = 2;
export const GBDT_LEARNING_RATE = 0.1;
export const GBDT_L2 = 1;
export const GBDT_BINS = 64;
export const GBDT_MIN_LEAF_ROWS = 1_000;
/** Une ligne sur cinq (index % 5 === 4) est mise de côté pour les métriques « held-out ». */
export const GBDT_HOLDOUT_EVERY = 5;
/** Plus petit fichier dont la partie entraînement (4 lignes sur 5) permet une coupe en deux feuilles de 1 000. */
export const GBDT_MIN_ROWS = 2_500;
/** Budget : lignes × variables × profondeur × arbres. 31 variables passent jusqu'à 32 258 lignes. */
export const GBDT_MAX_OPERATIONS = 300_000_000;
export const THRESHOLD_SIG_FIGS = 3;
export const LEAF_SIG_FIGS = 4;

export type GbdtNode =
  | { value: number }
  | { feature: number; threshold: number; left: GbdtNode; right: GbdtNode };

export function isHeldOut(row: number): boolean {
  return row % GBDT_HOLDOUT_EVERY === GBDT_HOLDOUT_EVERY - 1;
}

export function gbdtOperations(rows: number, features: number): number {
  return rows * features * GBDT_MAX_DEPTH * GBDT_TREES;
}

/** Arrondit à `sig` chiffres significatifs ; idempotent. */
export function roundSig(value: number, sig: number): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  return Number(value.toPrecision(sig));
}

/** Score brut (log-odds) : `values[i]` est la variable `features[i]` du modèle. Gauche si strictement inférieur au seuil. */
export function gbdtScore(baseScore: number, trees: readonly GbdtNode[], values: ArrayLike<number>): number {
  let score = baseScore;
  for (const tree of trees) {
    let node = tree;
    while ("feature" in node) node = values[node.feature] < node.threshold ? node.left : node.right;
    score += node.value;
  }
  return score;
}

export function sigmoid(value: number): number {
  return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
}

/** AUC exacte (rangs moyens en cas d'égalité) ; `null` si une classe est absente. */
export function binaryAuc(scores: ArrayLike<number>, labels: ArrayLike<number>): number | null {
  const n = scores.length;
  const order = Array.from({ length: n }, (_, index) => index).sort((a, b) => scores[a] - scores[b] || a - b);
  let positives = 0;
  let positiveRanks = 0;
  for (let start = 0; start < n;) {
    let end = start;
    while (end + 1 < n && scores[order[end + 1]] === scores[order[start]]) end++;
    const rank = (start + end) / 2 + 1;
    for (let index = start; index <= end; index++) {
      if (labels[order[index]] === 1) {
        positives++;
        positiveRanks += rank;
      }
    }
    start = end + 1;
  }
  const negatives = n - positives;
  if (positives === 0 || negatives === 0) return null;
  return (positiveRanks - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/** Structure d'un arbre livré : profondeur bornée, variables connues, valeurs finies, aucun champ libre. */
export function isGbdtNode(value: unknown, featureCount: number, depth = 0): value is GbdtNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  const keys = Object.keys(node);
  if (keys.length === 1 && keys[0] === "value") return typeof node.value === "number" && Number.isFinite(node.value);
  return depth < GBDT_MAX_DEPTH && keys.length === 4 &&
    typeof node.feature === "number" && Number.isSafeInteger(node.feature) && node.feature >= 0 && node.feature < featureCount &&
    typeof node.threshold === "number" && Number.isFinite(node.threshold) &&
    isGbdtNode(node.left, featureCount, depth + 1) && isGbdtNode(node.right, featureCount, depth + 1);
}
