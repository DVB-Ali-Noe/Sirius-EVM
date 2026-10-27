/**
 * Profil « gradient_boosted_trees » v1.1 : arbres boostés stricts pour une cible binaire 0/1.
 *
 * Module pur, partagé par l'enclave (entraînement, porte de sortie), le navigateur (contrôle
 * du CSV, évaluation, prédiction) et la validation des modèles livrés. Les constantes du
 * profil sont la source unique : les modifier change le profil et impose une nouvelle version
 * (`MODEL_REGISTRY.gradient_boosted_trees.version`, ancrée on-chain par `trainingProfileHash`).
 *
 * Réglage « strict » des essais model-zoo (profondeur 2, feuilles d'au moins 1 000 lignes) :
 * mesuré par l'audit confidentialité (`audit/confidentialite`, 23 octobre 2026), il ramène
 * l'attaque d'appartenance sur lignes **non répétées** sous 0,55 (LiRA 0,53 au pire sur Taïwan),
 * mais pas sur les lignes répétées : sans plafond d'influence, une ligne présente 20 fois était
 * reconnue à AUC 0,72–0,81. 150 arbres à 0,1 plutôt que 300 à 0,05 : même AUC held-out sur
 * Taïwan (0,787), moitié moins de calcul et de sortie. Aucun tirage aléatoire : même fichier,
 * même modèle.
 *
 * Version 1.1.0 (E2 minimale, constats CONF-01 à CONF-07 de l'audit) :
 * - plafond d'influence k = 1 : une seule copie de chaque ligne distincte (variables + cible)
 *   entre dans l'entraînement ; les copies écartées comptent dans `n` seulement ;
 * - seuils strictement entre deux valeurs voisines du fichier, jamais égaux à l'une d'elles ;
 * - `baseScore` à 3 chiffres ; métriques held-out à 3 décimales ; `trainAuc` remplacé par
 *   l'écart `aucGap = trainAuc − heldOutAuc` à 2 décimales ; `n` à 2 chiffres significatifs ;
 * - noms des colonnes publiées limités à `[A-Za-z0-9_]{1,64}`.
 */

export const GBDT_TREES = 150;
export const GBDT_MAX_DEPTH = 2;
export const GBDT_LEARNING_RATE = 0.1;
export const GBDT_L2 = 1;
export const GBDT_BINS = 64;
export const GBDT_MIN_LEAF_ROWS = 1_000;
/** Une ligne sur cinq (index % 5 === 4) est mise de côté pour les métriques « held-out ». */
export const GBDT_HOLDOUT_EVERY = 5;
/**
 * Avec des feuilles d'au moins 1 000 lignes, un petit fichier ne permet que des coupes proches
 * de la médiane : sous 10 000 lignes, les arbres font moins bien que la logistique.
 */
export const GBDT_MIN_ROWS = 10_000;
/** Même texte dans le navigateur et dans l'enclave ; à garder aligné sur `GBDT_MIN_ROWS`. */
export const GBDT_TOO_FEW_ROWS_MESSAGE = "Les arbres boostés demandent au moins 10 000 lignes ; utilise la régression logistique pour ce fichier.";
/** Budget : lignes × variables × profondeur × arbres. 31 variables passent jusqu'à 32 258 lignes. */
export const GBDT_MAX_OPERATIONS = 300_000_000;
/**
 * Un seuil est le décimal le plus court strictement compris entre deux valeurs voisines du
 * fichier : 3 chiffres significatifs quand c'est possible, jusqu'à `THRESHOLD_MAX_SIG_FIGS`
 * sinon ; au-delà, la coupe est abandonnée. La porte de sortie arrondit à ce maximum.
 */
export const THRESHOLD_SIG_FIGS = 3;
export const THRESHOLD_MAX_SIG_FIGS = 6;
export const LEAF_SIG_FIGS = 4;
/** `ln(positifs / négatifs)` : 3 chiffres suffisent au score et ne bougent plus à l'ajout de quelques lignes. */
export const BASE_SCORE_SIG_FIGS = 3;
/** Au plus une copie de chaque ligne distincte (variables + cible) dans les gradients et les feuilles. */
export const GBDT_INFLUENCE_CAP = 1;
/** Métriques held-out publiées à 3 décimales : un pas de 10⁻³ ne reconstruit plus la matrice de confusion. */
export const GBDT_METRIC_DECIMALS = 3;
/** Écart `trainAuc − heldOutAuc` publié à 2 décimales : le sur-apprentissage, sans l'empreinte du jeu. */
export const GBDT_AUC_GAP_DECIMALS = 2;
/** `n` publié à 2 chiffres significatifs (24 317 → 24 000). */
export const GBDT_ROW_COUNT_SIG_FIGS = 2;
/** Noms des colonnes publiées avec le modèle (variables et cible) : aucun caractère libre. */
export const GBDT_HEADER_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
/** Même texte dans le navigateur et dans l'enclave. */
export const GBDT_HEADER_MESSAGE = "Pour les arbres boostés, les noms des colonnes numériques sont publiés avec le modèle : lettres sans accent, chiffres et « _ » seulement, 64 caractères au plus.";
/** Même texte dans le navigateur et dans l'enclave. */
export const GBDT_TOO_FEW_DISTINCT_ROWS_MESSAGE = "Les arbres boostés n'entraînent qu'une copie de chaque ligne : il faut au moins 1 000 lignes d'entraînement distinctes.";

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

/** Arrondit à `decimals` décimales ; idempotent. */
export function roundDecimals(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(decimals));
}

/**
 * Seuil publié entre deux valeurs voisines `below < above` du fichier : le décimal le plus court
 * (de `THRESHOLD_SIG_FIGS` à `THRESHOLD_MAX_SIG_FIGS` chiffres) du milieu qui reste strictement
 * dans l'intervalle ouvert. Jamais égal à une valeur d'une ligne ; `null` si aucun décimal assez
 * court ne sépare les deux valeurs (coupe abandonnée).
 */
export function thresholdBetween(below: number, above: number): number | null {
  if (!(below < above)) return null;
  const middle = (below + above) / 2;
  for (let sig = THRESHOLD_SIG_FIGS; sig <= THRESHOLD_MAX_SIG_FIGS; sig++) {
    const candidate = roundSig(middle, sig);
    if (candidate > below && candidate < above) return candidate;
  }
  return null;
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
