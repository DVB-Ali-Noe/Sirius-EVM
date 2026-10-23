/**
 * Outils communs du banc « confidentialité » : chargement des jeux publics, découpage
 * entraînement / tenu à l'écart au format exact de l'enclave (une ligne sur cinq), canaris,
 * scores, pertes, AUC et statistiques (Wilson, bootstrap, test z, t de Student).
 *
 * Le banc appelle le vrai code d'entraînement du dépôt (`trainGradientBoostedTrees`,
 * `trainLogisticRegression`) puis la vraie porte de sortie (`gateModel`) : ce qui est mesuré
 * est le modèle livré à l'acheteur, pas une approximation.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gateModel } from "@/lib/tee/output-gate";
import { trainLogisticRegression } from "@/lib/tee/train";
import { trainGradientBoostedTrees } from "@/lib/tee/train-gbdt";
import { GBDT_HOLDOUT_EVERY, gbdtScore, isHeldOut, sigmoid, type GbdtNode } from "@/lib/models/gbdt";
import type { GradientBoostedTreesModel, LogisticRegressionModel } from "@/lib/models/registry";

// 30 s : le maximum accepté par le runner ; le banc enchaîne des centaines d'entraînements.
process.env.RUNNER_TRAINING_TIMEOUT_MS ??= "30000";

export const AUDIT_DIR = resolve(process.cwd(), "audit/confidentialite");
export const DATA_DIR = resolve(AUDIT_DIR, "data");
export const RESULTS_DIR = resolve(AUDIT_DIR, "results");

export interface Dataset {
  name: string;
  header: string[]; // variables puis cible
  rows: number[][]; // valeurs numériques, cible en dernier
}

export const DATASETS: Record<string, string> = {
  taiwan: resolve(DATA_DIR, "taiwan.csv"),
  gmsc: resolve(DATA_DIR, "gmsc.csv"),
  "credit-risk": resolve(process.cwd(), "public/examples/classification/credit-risk.csv"),
};

export function loadDataset(name: string): Dataset | null {
  const path = DATASETS[name];
  if (!path || !existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
  const header = lines[0].split(",");
  const rows = lines.slice(1).map((line) => line.split(",").map(Number));
  return { name, header, rows };
}

/** Jeux disponibles, dans l'ordre demandé ; les absents sont signalés (OpenML indisponible). */
export function availableDatasets(names: string[]): { datasets: Dataset[]; missing: string[] } {
  const datasets: Dataset[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const dataset = loadDataset(name);
    if (dataset) datasets.push(dataset);
    else missing.push(name);
  }
  return { datasets, missing };
}

// ---------------------------------------------------------------- aléa déterministe

export function rng(seed: number) {
  let state = (seed * 2_654_435_761) >>> 0 || 1;
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4_294_967_296;
  };
  const int = (bound: number) => Math.floor(next() * bound);
  const shuffle = <T>(items: T[]): T[] => {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  return { next, int, shuffle };
}

// ---------------------------------------------------------------- CSV et découpage

export function toCsv(header: string[], rows: number[][]): Buffer {
  const lines = [header.join(",")];
  for (const row of rows) lines.push(row.join(","));
  return Buffer.from(lines.join("\n"));
}

/**
 * Reproduit la séparation de l'enclave : la ligne d'index i (0 = première ligne de données)
 * est tenue à l'écart si i % 5 === 4. On place les lignes « entraînement » sur les autres
 * index et les lignes « écart » sur ceux-là ; il faut |écart| = floor(|entraînement| / 4).
 */
export function layout(train: number[][], heldOut: number[][]): { rows: number[][]; trainIdx: number[]; heldOutIdx: number[] } {
  const needHeld = Math.floor(train.length / (GBDT_HOLDOUT_EVERY - 1));
  if (heldOut.length < needHeld) throw new Error(`layout : il manque ${needHeld - heldOut.length} lignes d'écart`);
  const used = heldOut.slice(0, needHeld);
  const total = train.length + used.length;
  const rows: number[][] = [];
  const trainIdx: number[] = [];
  const heldOutIdx: number[] = [];
  let t = 0;
  let h = 0;
  for (let i = 0; i < total; i++) {
    if (isHeldOut(i) && h < used.length) {
      rows.push(used[h++]);
      heldOutIdx.push(i);
    } else if (t < train.length) {
      rows.push(train[t++]);
      trainIdx.push(i);
    } else {
      rows.push(used[h++]);
      heldOutIdx.push(i);
    }
  }
  // Toute ligne d'entraînement doit être sur un index non tenu à l'écart.
  for (const i of trainIdx) if (isHeldOut(i)) throw new Error("layout : ligne d'entraînement sur un index tenu à l'écart");
  return { rows, trainIdx, heldOutIdx };
}

/** Plafond d'influence simulé : au plus `k` copies de chaque ligne strictement identique. */
export function capDuplicates(rows: number[][], k: number): { rows: number[][]; removed: number } {
  if (!Number.isFinite(k)) return { rows, removed: 0 };
  const seen = new Map<string, number>();
  const kept: number[][] = [];
  for (const row of rows) {
    const key = row.join(",");
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count <= k) kept.push(row);
  }
  return { rows: kept, removed: rows.length - kept.length };
}

export function duplicateStats(rows: number[][]): { distinct: number; maxMultiplicity: number; repeatedRows: number } {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.join(",");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let max = 0;
  let repeated = 0;
  for (const count of counts.values()) {
    if (count > max) max = count;
    if (count > 1) repeated += count;
  }
  return { distinct: counts.size, maxMultiplicity: max, repeatedRows: repeated };
}

// ---------------------------------------------------------------- canaris

/**
 * Canari « atypique » : chaque variable est tirée dans la marge empirique d'une colonne (valeurs
 * donc plausibles une à une), mais la combinaison est inédite ; cible = 1 (classe positive,
 * la plus sensible : « cette personne a fait défaut »). Les témoins sont tirés de la même façon
 * et jamais insérés : la seule différence entre canaris et témoins est l'appartenance.
 */
export function makeCanary(dataset: Dataset, pool: number[][], random: ReturnType<typeof rng>): number[] {
  const features = dataset.header.length - 1;
  const row: number[] = [];
  for (let feature = 0; feature < features; feature++) row.push(pool[random.int(pool.length)][feature]);
  row.push(1);
  return row;
}

// ---------------------------------------------------------------- entraînement et scores

export type Trainer = "gbdt" | "logistic";

export interface Trained {
  trainer: Trainer;
  model: GradientBoostedTreesModel | LogisticRegressionModel;
  /** Score brut (log-odds) d'une ligne (variables dans l'ordre de l'en-tête). */
  score: (row: ArrayLike<number>) => number;
  /** Lignes effectivement vues par l'entraînement (indices dans `rows` passées à `train`). */
  trainIdx: number[];
  heldOutIdx: number[];
  ms: number;
}

/**
 * Entraîne comme l'enclave et passe la porte de sortie. Pour les arbres, `rows` suit le
 * découpage une-sur-cinq ; pour la logistique (qui apprend sur tout le fichier), seules les
 * lignes d'entraînement lui sont données, l'écart restant les non-membres.
 */
/**
 * Le runner borne chaque entraînement à 30 s au plus ; quand le banc fait tourner plusieurs
 * processus en parallèle, un entraînement peut dépasser ce délai par simple contention CPU.
 * L'entraînement étant déterministe, on le relance : le résultat est identique.
 */
function withBudgetRetry<T>(run: () => T, attempts = 5): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return run();
    } catch (error) {
      if (attempt >= attempts || !(error instanceof Error) || !/budget de calcul dépassé/.test(error.message)) throw error;
      console.error(`budget de calcul dépassé (contention CPU), nouvel essai ${attempt + 1}/${attempts}`);
    }
  }
}

export function train(trainer: Trainer, header: string[], rows: number[][], trainIdx: number[], heldOutIdx: number[]): Trained {
  const started = performance.now();
  if (trainer === "gbdt") {
    const csv = toCsv(header, rows);
    const model = gateModel(withBudgetRetry(() => trainGradientBoostedTrees(csv))).model;
    const score = (row: ArrayLike<number>) => gbdtScore(model.baseScore, model.trees, row);
    return { trainer, model, score, trainIdx, heldOutIdx, ms: performance.now() - started };
  }
  const csv = toCsv(header, trainIdx.map((i) => rows[i]));
  const model = gateModel(withBudgetRetry(() => trainLogisticRegression(csv))).model;
  const score = (row: ArrayLike<number>) => {
    let value = model.coefficients[0];
    for (let feature = 1; feature < model.coefficients.length; feature++) value += model.coefficients[feature] * row[feature - 1];
    return value;
  };
  return { trainer, model, score, trainIdx, heldOutIdx, ms: performance.now() - started };
}

export const sigmoidScoreToProbability = sigmoid;
export const isHeldOutIndex = isHeldOut;

/** Perte logistique d'une ligne étiquetée (dernier champ = cible). */
export function rowLoss(trained: Trained, row: number[]): number {
  const p = sigmoid(trained.score(row));
  const y = row[row.length - 1];
  const eps = 1e-12;
  return -(y === 1 ? Math.log(Math.max(p, eps)) : Math.log(Math.max(1 - p, eps)));
}

/** Confiance « logit-scaled » de la vraie classe (Carlini et al., 2022). */
export function rowConfidence(trained: Trained, row: number[]): number {
  const s = trained.score(row);
  return row[row.length - 1] === 1 ? s : -s;
}

export function walkTree(node: GbdtNode, visit: (node: GbdtNode, depth: number) => void, depth = 0): void {
  visit(node, depth);
  if ("feature" in node) {
    walkTree(node.left, visit, depth + 1);
    walkTree(node.right, visit, depth + 1);
  }
}

// ---------------------------------------------------------------- statistiques

export function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function sd(values: number[]): number {
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / Math.max(values.length - 1, 1));
}

export function quantile(values: number[], q: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const position = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[position];
}

/** Quantile de Student bilatéral à 95 % (table, puis 1,96 au-delà de 60 ddl). */
export function t95(df: number): number {
  const table: Record<number, number> = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086, 25: 2.060, 30: 2.042, 40: 2.021, 60: 2.000 };
  if (df <= 0) return Number.NaN;
  if (table[df]) return table[df];
  const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
  for (const key of keys) if (key > df) return table[key];
  return 1.96;
}

/** Moyenne et intervalle t à 95 % sur des répétitions indépendantes (graines). */
export function meanCi(values: number[]): { mean: number; low: number; high: number; n: number } {
  const n = values.length;
  const m = mean(values);
  const half = n > 1 ? (t95(n - 1) * sd(values)) / Math.sqrt(n) : Number.NaN;
  return { mean: m, low: m - half, high: m + half, n };
}

/** Test t apparié (différences par graine), bilatéral ; p approché par la loi normale si ddl > 30. */
export function pairedT(differences: number[]): { t: number; p: number; df: number } {
  const n = differences.length;
  const m = mean(differences);
  const s = sd(differences);
  if (s === 0) return { t: m === 0 ? 0 : Number.POSITIVE_INFINITY, p: m === 0 ? 1 : 0, df: n - 1 };
  const t = m / (s / Math.sqrt(n));
  return { t, p: tTwoSidedP(t, n - 1), df: n - 1 };
}

/** p bilatéral de Student (intégration numérique de la densité ; suffisant pour un rapport). */
export function tTwoSidedP(t: number, df: number): number {
  const x = Math.abs(t);
  if (!Number.isFinite(x)) return 0;
  const lnGamma = (z: number): number => {
    // Lanczos
    const g = 7;
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
    z -= 1;
    let a = c[0];
    const tt = z + g + 0.5;
    for (let i = 1; i < g + 2; i++) a += c[i] / (z + i);
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(tt) - tt + Math.log(a);
  };
  const logNorm = lnGamma((df + 1) / 2) - lnGamma(df / 2) - 0.5 * Math.log(df * Math.PI);
  const density = (u: number) => Math.exp(logNorm - ((df + 1) / 2) * Math.log(1 + (u * u) / df));
  // Simpson sur [0, x], puis queue = 0,5 - intégrale.
  const steps = 2000;
  const h = x / steps;
  let sum = density(0) + density(x);
  for (let i = 1; i < steps; i++) sum += density(i * h) * (i % 2 === 0 ? 2 : 4);
  const integral = (sum * h) / 3;
  return Math.max(0, Math.min(1, 2 * (0.5 - integral)));
}

export function normalTwoSidedP(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  // erfc, approximation d'Abramowitz-Stegun 7.1.26 (erreur < 1,5e-7)
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return Math.max(0, 1 - erf);
}

/** Intervalle de Wilson à 95 % pour une proportion. */
export function wilson(successes: number, total: number): { rate: number; low: number; high: number } {
  if (total === 0) return { rate: Number.NaN, low: Number.NaN, high: Number.NaN };
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { rate: p, low: centre - half, high: centre + half };
}

/** Test z de deux proportions (variance groupée), bilatéral. */
export function twoProportions(k1: number, n1: number, k2: number, n2: number): { diff: number; z: number; p: number } {
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const pooled = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const z = se === 0 ? 0 : (p1 - p2) / se;
  return { diff: p1 - p2, z, p: se === 0 ? 1 : normalTwoSidedP(z) };
}

/** AUC exacte avec rangs moyens (score élevé = positif). */
export function auc(positives: number[], negatives: number[]): number {
  const all = positives.map((s) => ({ s, y: 1 })).concat(negatives.map((s) => ({ s, y: 0 }))).sort((a, b) => a.s - b.s);
  let rankSum = 0;
  for (let start = 0; start < all.length;) {
    let end = start;
    while (end + 1 < all.length && all[end + 1].s === all[start].s) end++;
    const rank = (start + end) / 2 + 1;
    for (let i = start; i <= end; i++) if (all[i].y === 1) rankSum += rank;
    start = end + 1;
  }
  const np = positives.length;
  const nn = negatives.length;
  if (np === 0 || nn === 0) return Number.NaN;
  return (rankSum - (np * (np + 1)) / 2) / (np * nn);
}

/** p bilatéral de Mann-Whitney (approximation normale, sans correction d'égalités) pour AUC ≠ 0,5. */
export function aucP(value: number, np: number, nn: number): number {
  const se = Math.sqrt((np + nn + 1) / (12 * np * nn));
  return normalTwoSidedP((value - 0.5) / se);
}

/** Intervalle bootstrap percentile (95 %) de l'AUC, rééchantillonnage stratifié. */
export function aucBootstrap(positives: number[], negatives: number[], random: ReturnType<typeof rng>, resamples = 400): { auc: number; low: number; high: number } {
  const point = auc(positives, negatives);
  const values: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const p = Array.from({ length: positives.length }, () => positives[random.int(positives.length)]);
    const n = Array.from({ length: negatives.length }, () => negatives[random.int(negatives.length)]);
    values.push(auc(p, n));
  }
  return { auc: point, low: quantile(values, 0.025), high: quantile(values, 0.975) };
}

/** Taux de vrais positifs au taux de faux positifs `fpr` (score élevé = membre). */
export function tprAtFpr(positives: number[], negatives: number[], fpr: number): number {
  const sortedNeg = negatives.slice().sort((a, b) => b - a);
  const threshold = sortedNeg[Math.max(0, Math.floor(fpr * negatives.length) - 1)] ?? Number.POSITIVE_INFINITY;
  return positives.filter((s) => s > threshold).length / positives.length;
}

export function saveResults(name: string, payload: unknown): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = resolve(RESULTS_DIR, `${name}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

export const fmtPct = (value: number, digits = 1) => `${(100 * value).toFixed(digits)} %`;
export const fmt = (value: number, digits = 3) => (Number.isFinite(value) ? value.toFixed(digits) : "—");
