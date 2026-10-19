import { isNumericCell } from "./csv-check";

/**
 * Rapport de qualité à l'import (E1, docs/EGRESS-POLICY-API.md) : calculé dans le navigateur sur
 * le fichier en clair, montré au seul fournisseur, jamais envoyé, stocké ni publié. Il signale,
 * il ne refuse rien et ne modifie pas le fichier (le Merkle root reste celui du fichier choisi).
 *
 * Les colonnes d'entraînement suivent la règle de l'enclave (`numericColumns`, src/lib/tee/train.ts) :
 * une colonne compte si toutes ses cellules sont numériques ; la cible est la dernière d'entre elles.
 * Coût linéaire : une passe par colonne, puis une passe par ligne sur les colonnes d'entraînement.
 */

/** Provisoire, à calibrer (annexe B de la note) : corrélation à partir de laquelle une variable semble recopier la cible. */
export const TARGET_COPY_MIN_ABS_CORRELATION = 0.98;
/** Provisoire, à calibrer : part de la classe minoritaire sous laquelle une cible 0/1 est signalée. */
export const MIN_MINORITY_CLASS_SHARE = 0.1;

export interface ExcludedColumn {
  column: string;
  /** Cellules vides ou absentes (ligne trop courte). */
  missing: number;
  /** Cellules non vides mais non numériques. */
  invalid: number;
}

export interface TargetCopy {
  column: string;
  kind: "identical" | "inverse" | "correlated";
  /** Corrélation de Pearson, arrondie à 3 décimales. */
  correlation: number;
}

export interface QualityReport {
  /** La dernière colonne du fichier n'est pas utilisable : l'enclave prendra une autre cible. */
  targetShift: { expected: string; actual: string } | null;
  /** Colonnes majoritairement numériques, écartées par l'entraînement à cause de quelques cellules. */
  excluded: ExcludedColumn[];
  /** Colonnes de texte, ignorées par l'entraînement. */
  textColumns: string[];
  /** Colonnes d'entraînement à valeur unique. */
  constant: string[];
  /** Lignes identiques sur les colonnes d'entraînement (variables et cible). */
  duplicates: { rows: number; maxRepeat: number };
  targetCopies: TargetCopy[];
  /** Cible 0/1 uniquement. */
  classBalance: { zeros: number; ones: number; minorityShare: number; imbalanced: boolean } | null;
}

export function hasQualitySignal(report: QualityReport): boolean {
  return (
    report.targetShift !== null ||
    report.excluded.length > 0 ||
    report.constant.length > 0 ||
    report.duplicates.rows > 0 ||
    report.targetCopies.length > 0 ||
    report.classBalance?.imbalanced === true
  );
}

/** `null` sans ligne de données : il n'y a rien à décrire. */
export function qualityReport(table: string[][]): QualityReport | null {
  if (table.length < 2) return null;
  const [header, ...rows] = table;
  const numeric: number[] = [];
  const excluded: ExcludedColumn[] = [];
  const textColumns: string[] = [];

  for (let column = 0; column < header.length; column++) {
    let missing = 0;
    let invalid = 0;
    for (const row of rows) {
      const cell = row[column] ?? "";
      if (cell === "") missing++;
      else if (!isNumericCell(cell)) invalid++;
    }
    const valid = rows.length - missing - invalid;
    if (missing + invalid === 0) numeric.push(column);
    else if (valid > invalid) excluded.push({ column: header[column], missing, invalid });
    else textColumns.push(header[column]);
  }

  const lastColumn = header.length - 1;
  const targetIdx = numeric.length > 0 ? numeric[numeric.length - 1] : -1;
  const targetShift = targetIdx >= 0 && targetIdx !== lastColumn ? { expected: header[lastColumn], actual: header[targetIdx] } : null;

  const values = numeric.map((column) => Float64Array.from(rows, (row) => Number(row[column])));

  const constant = numeric.filter((_, index) => values[index].every((value) => value === values[index][0])).map((column) => header[column]);

  const counts = new Map<string, number>();
  // Sans variable explicative, il n'y a pas d'entraînement possible : la cible seule se répète forcément.
  for (let row = 0; values.length > 1 && row < rows.length; row++) {
    // Valeurs numériques sérialisées, séparées par \u0000 : aucune représentation de nombre n'en contient.
    let key = "";
    for (let index = 0; index < values.length; index++) key += (index ? "\u0000" : "") + values[index][row];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let duplicateRows = 0;
  let maxRepeat = counts.size > 0 ? 1 : 0;
  for (const count of counts.values()) {
    if (count < 2) continue;
    duplicateRows += count;
    if (count > maxRepeat) maxRepeat = count;
  }

  const targetCopies: TargetCopy[] = [];
  let classBalance: QualityReport["classBalance"] = null;
  if (targetIdx >= 0) {
    const target = values[values.length - 1];
    const binary = rows.every((row) => row[targetIdx] === "0" || row[targetIdx] === "1");
    for (let index = 0; index < values.length - 1; index++) {
      const feature = values[index];
      const identical = feature.every((value, row) => value === target[row]);
      const inverse = binary && feature.every((value, row) => value === 1 - target[row]);
      const correlation = pearson(feature, target);
      if (identical || inverse || Math.abs(correlation) >= TARGET_COPY_MIN_ABS_CORRELATION) {
        targetCopies.push({
          column: header[numeric[index]],
          kind: identical ? "identical" : inverse ? "inverse" : "correlated",
          correlation: Math.round(correlation * 1000) / 1000,
        });
      }
    }
    if (binary) {
      const ones = target.reduce((sum, value) => sum + value, 0);
      const zeros = rows.length - ones;
      const minorityShare = Math.min(zeros, ones) / rows.length;
      classBalance = { zeros, ones, minorityShare, imbalanced: minorityShare < MIN_MINORITY_CLASS_SHARE };
    }
  }

  return { targetShift, excluded, textColumns, constant, duplicates: { rows: duplicateRows, maxRepeat }, targetCopies, classBalance };
}

/** Corrélation de Pearson en deux passes (moyennes, puis écarts) ; 0 si une série est constante. */
function pearson(x: Float64Array, y: Float64Array): number {
  const n = x.length;
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < n; i++) {
    meanX += x[i];
    meanY += y[i];
  }
  meanX /= n;
  meanY /= n;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  return varianceX === 0 || varianceY === 0 ? 0 : covariance / Math.sqrt(varianceX * varianceY);
}
