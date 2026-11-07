import { CsvValidationError, MAX_CSV_COLUMNS, isMostlyNumeric } from "@/lib/sirius/metrics";
import { MAX_HEADER_CHARS, MAX_TRAINING_FEATURES, MIN_ROWS_PER_PARAMETER, MIN_TRAINING_ROWS } from "@/lib/tee/train";
import { GBDT_HEADER_PATTERN, GBDT_MIN_ROWS } from "@/lib/models/gbdt";
import type { ModelId } from "@/lib/models/registry";
import { MAX_CHUNKED_CSV_ROWS, StrictCsvStream, type CsvStreamSummary } from "@/lib/upload/csv-stream";
import { MERKLE_LEAF_BYTES, merkleRootFromLeaves, plaintextLeaves } from "@/lib/upload/chunked";
import type { ChunkedFileSource } from "@/lib/upload/chunked-transfer";
import type { CsvInspection, CsvRejection, CsvSummary } from "./csv-check";

/**
 * Contrôle d'un gros CSV (envoi en morceaux) dans le navigateur, sans le charger en entier : le
 * fichier est lu par tranches de 1 Mio avec le lecteur en flux de l'enclave (`StrictCsvStream`),
 * et la racine de Merkle du clair est calculée au passage (c'est celle du titre on-chain).
 *
 * Les refus reprennent ceux de `inspectCsvTable`, dans le même ordre. Deux contrôles restent à
 * l'enclave, comme pour elle : le budget de calcul et les classes de chaque côté de la séparation
 * entraînement / test des arbres. Pas de rapport de qualité : il exigerait de garder les lignes.
 */

const READ_BYTES = 16 * MERKLE_LEAF_BYTES;

export type LargeCsvRead =
  | { ok: true; summary: CsvStreamSummary; merkleRoot: string }
  | { ok: false; reason: CsvRejection };

function streamRejection(error: unknown): CsvRejection {
  if (error instanceof CsvValidationError && error.problem) return { kind: "malformed", problem: error.problem };
  const message = error instanceof Error ? error.message : "";
  if (message.includes("trop de lignes")) return { kind: "too-many-rows", maxRows: MAX_CHUNKED_CSV_ROWS };
  if (message.includes("trop de colonnes")) return { kind: "too-many-columns", maxColumns: MAX_CSV_COLUMNS };
  if (message.includes("cellule")) return { kind: "cell-too-large" };
  return { kind: "unreadable" };
}

/** Lit le fichier une fois : résumé par colonne et racine de Merkle. `onProgress` reçoit 0 à 1. */
export async function readLargeCsv(
  source: ChunkedFileSource,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<LargeCsvRead> {
  const csv = new StrictCsvStream();
  const leaves: string[] = [];
  try {
    for (let offset = 0; offset < source.sizeBytes; offset += READ_BYTES) {
      signal?.throwIfAborted();
      const bytes = await source.read(offset, Math.min(READ_BYTES, source.sizeBytes - offset));
      csv.pushBytes(bytes);
      leaves.push(...(await plaintextLeaves(bytes)));
      onProgress?.(Math.min(1, (offset + bytes.length) / source.sizeBytes));
    }
    const summary = csv.end();
    return { ok: true, summary, merkleRoot: await merkleRootFromLeaves(leaves) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, reason: streamRejection(error) };
  }
}

/** Même décision que `inspectCsvTable`, à partir des décomptes par colonne. */
export function inspectStreamSummary(stream: CsvStreamSummary, modelId: ModelId): CsvInspection {
  const { header, rowCount, columns } = stream;
  if (rowCount < 1) return { ok: false, reason: { kind: "no-data-rows" }, summary: { rowCount: 0 } };
  const summary: Partial<CsvSummary> = { rowCount, columnCount: header.length, header };
  if (new Set(header).size !== header.length || header.some((column) => !column || column.length > MAX_HEADER_CHARS)) {
    return { ok: false, reason: { kind: "invalid-header" }, summary };
  }
  const numericIndexes = header.map((_, column) => column).filter((column) => columns[column].numeric === rowCount);
  summary.numericColumns = numericIndexes.map((column) => header[column]);
  if (numericIndexes.length < 2) {
    return { ok: false, reason: { kind: "too-few-numeric-columns", found: numericIndexes.length }, summary };
  }
  if (numericIndexes.length > MAX_TRAINING_FEATURES + 1) {
    return {
      ok: false,
      reason: { kind: "too-many-features", found: numericIndexes.length - 1, maxFeatures: MAX_TRAINING_FEATURES },
      summary,
    };
  }
  const targetIdx = numericIndexes[numericIndexes.length - 1];
  const featureIdx = numericIndexes.filter((column) => column !== targetIdx);
  summary.target = header[targetIdx];
  summary.features = featureIdx.map((column) => header[column]);
  const trees = modelId === "gradient_boosted_trees";
  if (trees && rowCount < GBDT_MIN_ROWS) return { ok: false, reason: { kind: "trees-too-few-rows" }, summary };
  const requiredRows = Math.max(MIN_TRAINING_ROWS, (featureIdx.length + 1) * MIN_ROWS_PER_PARAMETER);
  if (rowCount < requiredRows) return { ok: false, reason: { kind: "too-few-rows", rows: rowCount, minRows: requiredRows }, summary };
  const last = columns[header.length - 1];
  if (last.missing + last.invalid > 0 && isMostlyNumeric(last)) {
    return {
      ok: false,
      reason: { kind: "incomplete-target", target: header[header.length - 1], missing: last.missing, invalid: last.invalid },
      summary,
    };
  }
  const target = columns[targetIdx];
  const binary = target.zeros + target.ones === rowCount && target.zeros > 0 && target.ones > 0;
  if (trees) {
    const published = [header[targetIdx], ...featureIdx.map((column) => header[column])].find((column) => !GBDT_HEADER_PATTERN.test(column));
    if (published !== undefined) return { ok: false, reason: { kind: "trees-header-charset", column: published }, summary };
    if (!binary) return { ok: false, reason: { kind: "binary-target", target: header[targetIdx] }, summary };
    return { ok: true, summary: summary as CsvSummary };
  }
  if (modelId === "logistic_regression" && !binary) {
    return { ok: false, reason: { kind: "logistic-target", target: header[targetIdx] }, summary };
  }
  return { ok: true, summary: summary as CsvSummary };
}
