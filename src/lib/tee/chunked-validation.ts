import { GBDT_HEADER_MESSAGE, GBDT_HEADER_PATTERN, GBDT_MIN_ROWS, GBDT_TOO_FEW_ROWS_MESSAGE } from "@/lib/models/gbdt";
import type { ModelSelection } from "@/lib/models/registry";
import { isMostlyNumeric, type DatasetMetrics } from "@/lib/sirius/metrics";
import type { CsvStreamSummary } from "@/lib/upload/csv-stream";
import {
  DatasetValidationError,
  MAX_HEADER_CHARS,
  MAX_TRAINING_FEATURES,
  MIN_ROWS_PER_PARAMETER,
  MIN_TRAINING_ROWS,
} from "./train";

/**
 * Contrôles d'ingestion d'un envoi en morceaux, sur le résumé du lecteur en flux : mêmes règles,
 * même ordre et mêmes messages que `validateTrainingDataset` (colonnes de `trainingColumns`, cible
 * incomplète, cible 0/1 des arbres et de la logistique).
 *
 * Deux contrôles restent à l'entraînement, faute de pouvoir les tenir sans garder les lignes :
 * le budget d'opérations (la voie lourde des gros fichiers a ses propres limites) et la présence
 * des deux classes de chaque côté de la séparation entraînement / test des arbres.
 */
export function validateChunkedDataset(summary: CsvStreamSummary, selection: ModelSelection): DatasetMetrics {
  const { header, rowCount, columns } = summary;
  const trees = selection.modelId === "gradient_boosted_trees";
  if (rowCount < 1) throw new DatasetValidationError("dataset insuffisant");
  if (new Set(header).size !== header.length || header.some((column) => !column || column.length > MAX_HEADER_CHARS)) {
    throw new DatasetValidationError("en-têtes CSV invalides");
  }

  // Colonne numérique au sens de `trainingColumns` : toutes ses cellules sont des nombres.
  const numeric = header.map((_, column) => column).filter((column) => columns[column].numeric === rowCount);
  if (numeric.length < 2) throw new DatasetValidationError("au moins 2 colonnes numériques requises");
  if (numeric.length > MAX_TRAINING_FEATURES + 1) {
    throw new DatasetValidationError(`trop de features numériques (max ${MAX_TRAINING_FEATURES})`);
  }
  const targetIdx = numeric[numeric.length - 1];
  const featureIdx = numeric.filter((column) => column !== targetIdx);
  if (trees && rowCount < GBDT_MIN_ROWS) throw new DatasetValidationError(GBDT_TOO_FEW_ROWS_MESSAGE);
  const requiredRows = Math.max(MIN_TRAINING_ROWS, (featureIdx.length + 1) * MIN_ROWS_PER_PARAMETER);
  if (rowCount < requiredRows) {
    throw new DatasetValidationError(`dataset trop petit pour préserver la confidentialité (min ${requiredRows} lignes)`);
  }

  const last = columns[header.length - 1];
  if (last.missing + last.invalid > 0 && isMostlyNumeric(last)) {
    throw new DatasetValidationError(
      `la dernière colonne « ${header[header.length - 1]} » sert de cible mais n'est pas entièrement numérique ` +
        `(${last.missing} cellule(s) vide(s), ${last.invalid} non numérique(s))`,
    );
  }

  const target = columns[targetIdx];
  const binary = target.zeros + target.ones === rowCount;
  const bothClasses = target.zeros > 0 && target.ones > 0;
  if (trees) {
    if (![targetIdx, ...featureIdx].every((column) => GBDT_HEADER_PATTERN.test(header[column]))) {
      throw new DatasetValidationError(GBDT_HEADER_MESSAGE);
    }
    if (!binary) throw new DatasetValidationError("la cible des arbres boostés doit être strictement 0 ou 1");
    if (!bothClasses) throw new DatasetValidationError("la cible des arbres boostés doit contenir les classes 0 et 1");
  } else if (selection.modelId === "logistic_regression" && !(binary && bothClasses)) {
    throw new DatasetValidationError("la cible de la régression logistique doit contenir les classes 0 et 1");
  }
  return { rowCount, columnCount: header.length };
}
