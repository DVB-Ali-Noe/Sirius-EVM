import { parseCsv } from "@/lib/sirius/metrics";

export interface TrainedModel {
  algo: "linear_regression";
  target: string;
  features: string[];
  coefficients: number[]; // [biais, ...features], aligné sur `features`
  metrics: { r2: number; rmse: number; n: number };
}

const RIDGE = 1e-8; // régularisation : stabilise l'inversion si XᵀX est quasi-singulier
export const MAX_TRAINING_FEATURES = 31;
export const MAX_TRAINING_OPERATIONS = 20_000_000;
const MAX_ABS_VALUE = 1e12;
const DEFAULT_TRAINING_TIMEOUT_MS = 15_000;
export const MIN_TRAINING_ROWS = 100;
export const MIN_ROWS_PER_PARAMETER = 10;

function isNum(v: string): boolean {
  const value = Number(v);
  return v !== "" && Number.isFinite(value) && Math.abs(value) <= MAX_ABS_VALUE;
}

function numericColumns(header: string[], rows: string[][]): number[] {
  return header.map((_, c) => c).filter((c) => rows.every((r) => isNum(r[c] ?? "")));
}

/** Inversion d'une matrice carrée par élimination de Gauss-Jordan. */
function assertWithinDeadline(deadline: number): void {
  if (performance.now() > deadline) throw new Error("budget de calcul dépassé");
}

function trainingTimeoutMs(): number {
  const value = Number(process.env.RUNNER_TRAINING_TIMEOUT_MS ?? DEFAULT_TRAINING_TIMEOUT_MS);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 30_000) {
    throw new Error("RUNNER_TRAINING_TIMEOUT_MS invalide");
  }
  return value;
}

function invert(matrix: number[][], deadline: number): number[][] {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);

  for (let col = 0; col < n; col++) {
    assertWithinDeadline(deadline);
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error("matrice singulière");
    [a[col], a[pivot]] = [a[pivot], a[col]];

    const d = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}

/**
 * Job fixe MVP : régression linéaire multivariée (moindres carrés via équations normales).
 * Cible = `target` ou, par défaut, la dernière colonne numérique ; features = les autres
 * colonnes numériques. Déterministe et sans code arbitraire fourni par le borrower.
 */
export function trainLinearRegression(csv: Buffer, target?: string): TrainedModel {
  const deadline = performance.now() + trainingTimeoutMs();
  const table = parseCsv(csv.toString("utf-8"));
  assertWithinDeadline(deadline);
  if (table.length < 2) throw new Error("dataset insuffisant");

  const [header, ...rows] = table;
  const numCols = numericColumns(header, rows);
  if (numCols.length < 2) throw new Error("au moins 2 colonnes numériques requises");
  if (numCols.length > MAX_TRAINING_FEATURES + 1) {
    throw new Error(`trop de features numériques (max ${MAX_TRAINING_FEATURES})`);
  }

  const targetIdx = target ? header.indexOf(target) : numCols[numCols.length - 1];
  if (!numCols.includes(targetIdx)) throw new Error("colonne cible non numérique");
  const featIdx = numCols.filter((c) => c !== targetIdx);
  const parameterCount = featIdx.length + 1;
  const requiredRows = Math.max(MIN_TRAINING_ROWS, parameterCount * MIN_ROWS_PER_PARAMETER);
  if (rows.length < requiredRows) {
    throw new Error(`dataset trop petit pour préserver la confidentialité (min ${requiredRows} lignes)`);
  }
  const p = parameterCount;
  if (rows.length * p * p > MAX_TRAINING_OPERATIONS) {
    throw new Error("budget de calcul dépassé : réduis le nombre de lignes ou de features");
  }

  // β = (XᵀX + λI)⁻¹ Xᵀy
  const XtX = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => (i === j ? RIDGE : 0)),
  );
  const Xty = Array<number>(p).fill(0);
  let ySum = 0;
  for (let k = 0; k < rows.length; k++) {
    if ((k & 127) === 0) assertWithinDeadline(deadline);
    const values = [1, ...featIdx.map((c) => Number(rows[k][c]))];
    const y = Number(rows[k][targetIdx]);
    ySum += y;
    for (let i = 0; i < p; i++) {
      Xty[i] += values[i] * y;
      for (let j = 0; j < p; j++) XtX[i][j] += values[i] * values[j];
    }
  }
  if (XtX.some((row) => row.some((value) => !Number.isFinite(value))) || Xty.some((value) => !Number.isFinite(value))) {
    throw new Error("valeurs numériques hors plage");
  }
  const beta = invert(XtX, deadline).map((row) => row.reduce((acc, v, j) => acc + v * Xty[j], 0));
  if (beta.some((value) => !Number.isFinite(value))) throw new Error("modèle numérique instable");

  // métriques sur l'échantillon d'entraînement (R², RMSE)
  const yMean = ySum / rows.length;
  let ssRes = 0;
  let ssTot = 0;
  for (let k = 0; k < rows.length; k++) {
    if ((k & 255) === 0) assertWithinDeadline(deadline);
    const values = [1, ...featIdx.map((c) => Number(rows[k][c]))];
    const y = Number(rows[k][targetIdx]);
    const pred = values.reduce((sum, value, j) => sum + value * beta[j], 0);
    ssRes += (y - pred) ** 2;
    ssTot += (y - yMean) ** 2;
  }
  if (!Number.isFinite(ssRes) || !Number.isFinite(ssTot)) throw new Error("métriques numériques instables");

  return {
    algo: "linear_regression",
    target: header[targetIdx],
    features: featIdx.map((c) => header[c]),
    coefficients: beta,
    metrics: { r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot, rmse: Math.sqrt(ssRes / rows.length), n: rows.length },
  };
}
