/**
 * Fichiers hostiles et classement des issues, partagés par les tests d'audit.
 *
 * `ingest` reproduit exactement la conversion faite par `sealDatasetEnvelope`
 * (src/lib/tee/core.ts) : `DatasetValidationError` ou `CsvValidationError` → 400, tout le reste
 * remonte tel quel (500 ou 503, compté par le coupe-circuit si ce n'est pas une AppError 4xx).
 */
import { CsvValidationError } from "@/lib/sirius/metrics";
import { DatasetValidationError, validateTrainingDataset } from "@/lib/tee/train";
import { trainSelectedModel } from "@/lib/tee/model-registry";
import type { DeliveredModel, ModelSelection } from "@/lib/models/registry";
import { prng } from "./datasets";

export const LOGISTIC: ModelSelection = { modelId: "logistic_regression", modelVersion: "1.0.0" };
export const LINEAR: ModelSelection = { modelId: "linear_regression", modelVersion: "1.0.0" };
export const TREES: ModelSelection = { modelId: "gradient_boosted_trees", modelVersion: "1.0.0" };

export type Ingestion = { kind: "accepted"; rowCount: number; columnCount: number } | { kind: "400"; message: string } | { kind: "crash"; error: string };

export function ingest(csv: string | Buffer, selection: ModelSelection): Ingestion {
  const content = typeof csv === "string" ? Buffer.from(csv, "utf-8") : csv;
  try {
    const metrics = validateTrainingDataset(content, selection);
    return { kind: "accepted", ...metrics };
  } catch (error) {
    if (error instanceof DatasetValidationError || error instanceof CsvValidationError) return { kind: "400", message: error.message };
    return { kind: "crash", error: `${(error as Error)?.constructor?.name}: ${(error as Error)?.message}` };
  }
}

export type Training = { kind: "trained"; model: DeliveredModel } | { kind: "failed"; error: string };

/** Même calcul que le worker (train-worker.ts) ; une exception y devient une 422 « Dataset inexploitable ». */
export function train(csv: string | Buffer, selection: ModelSelection): Training {
  const content = typeof csv === "string" ? Buffer.from(csv, "utf-8") : csv;
  try {
    return { kind: "trained", model: trainSelectedModel(selection, content) };
  } catch (error) {
    return { kind: "failed", error: `${(error as Error)?.constructor?.name}: ${(error as Error)?.message}` };
  }
}

export function metricsFinite(model: DeliveredModel): boolean {
  return Object.values(model.metrics as Record<string, unknown>).every((value) => value === null || (typeof value === "number" && Number.isFinite(value)));
}

/** Cellules hostiles demandées par l'audit, plus quelques variantes de `Number()`. */
export const HOSTILE_CELLS = [
  "0x1A", "0X1a", "0b101", "0o17", " 5 ", "  ", "\t", "", "NaN", "Infinity", "-Infinity", "1e300", "-1e300",
  "-0", "+0", "1e12", "1.0000001e12", ".5", "5.", "1_000", "1,5", "﻿5", " 7", "１", "abc", '"', '""',
  "x".repeat(10_000), "x".repeat(10_001), "9".repeat(400),
];

export interface HostileShape {
  columns: number;
  rows: number;
  hostileRate: number;
  bom: boolean;
  lineEndings: "lf" | "crlf" | "mixed" | "cr";
  trailing: 0 | 1 | 2;
  unclosedQuote: boolean;
  header: "normal" | "long128" | "long129" | "empty" | "duplicate" | "quoted";
  targetMode: "binary" | "binary-dirty" | "continuous" | "single-class";
  duplicates: boolean;
}

/**
 * `mild` : chaque perturbation n'apparaît qu'avec une probabilité de 15 %, pour qu'une bonne part
 * des fichiers passe l'ingestion et atteigne l'entraînement avec des valeurs hostiles isolées.
 */
export function randomShape(random: () => number, mild = false): HostileShape {
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
  const sometimes = <T,>(normal: T, hostile: () => T): T => (!mild || random() < 0.15 ? hostile() : normal);
  return {
    columns: mild ? pick([2, 3, 5, 8, 16, 31, 32, 33, 64] as const) : pick([1, 2, 3, 5, 8, 16, 31, 32, 33, 63, 64, 65] as const),
    rows: mild ? pick([100, 150, 330, 400] as const) : pick([0, 1, 2, 50, 99, 100, 101, 150, 330, 400] as const),
    hostileRate: mild ? pick([0, 0.0005, 0.001, 0.002] as const) : pick([0, 0, 0.0005, 0.002, 0.02, 0.2] as const),
    bom: sometimes(false, () => random() < 0.5),
    lineEndings: sometimes("lf" as const, () => pick(["lf", "lf", "crlf", "mixed", "cr"] as const)),
    trailing: sometimes(1 as const, () => pick([0, 1, 1, 2] as const)),
    unclosedQuote: sometimes(false, () => random() < 0.3),
    header: sometimes("normal" as const, () => pick(["normal", "normal", "normal", "long128", "long129", "empty", "duplicate", "quoted"] as const)),
    targetMode: sometimes("binary" as const, () => pick(["binary", "binary", "binary-dirty", "continuous", "single-class"] as const)),
    duplicates: sometimes(false, () => random() < 0.2),
  };
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function hostileCsv(shape: HostileShape, seed: number): string {
  const random = prng(seed);
  const header = Array.from({ length: shape.columns }, (_, i) => `c${i}`);
  if (shape.header === "long128") header[0] = "h".repeat(128);
  if (shape.header === "long129") header[0] = "h".repeat(129);
  if (shape.header === "empty") header[0] = "";
  if (shape.header === "duplicate" && header.length > 1) header[1] = header[0];
  if (shape.header === "quoted") header[0] = 'nom, "cité"\nsur deux lignes';
  const cellRows: string[][] = [header.map(quote)];
  const base = Array.from({ length: shape.columns - 1 }, () => (random() * 100).toFixed(2));
  for (let row = 0; row < shape.rows; row++) {
    const cells: string[] = [];
    for (let column = 0; column < shape.columns - 1; column++) {
      let cell = shape.duplicates ? base[column] : (random() * 100 - 50).toFixed(Math.floor(random() * 4));
      if (random() < shape.hostileRate) cell = HOSTILE_CELLS[Math.floor(random() * HOSTILE_CELLS.length)];
      cells.push(random() < 0.5 ? quote(cell) : cell.includes('"') || cell.includes(",") ? quote(cell) : cell);
    }
    let target: string;
    switch (shape.targetMode) {
      case "binary": target = shape.duplicates ? String(row % 2) : random() < 0.5 ? "0" : "1"; break;
      case "binary-dirty": target = random() < 0.01 ? HOSTILE_CELLS[Math.floor(random() * HOSTILE_CELLS.length)] : String(row % 2); break;
      case "continuous": target = (random() * 1000).toFixed(3); break;
      case "single-class": target = "1"; break;
    }
    cells.push(quote(target));
    cellRows.push(cells);
  }
  const ending = (index: number) => {
    switch (shape.lineEndings) {
      case "lf": return "\n";
      case "crlf": return "\r\n";
      case "cr": return "\r";
      case "mixed": return ["\n", "\r\n", "\r"][Math.floor(prng(seed + index)() * 3)];
    }
  };
  let text = cellRows.map((cells, index) => cells.join(",") + (index < cellRows.length - 1 ? ending(index) : "")).join("");
  for (let i = 0; i < shape.trailing; i++) text += ending(cellRows.length + i);
  if (shape.unclosedQuote && text.length > 2) {
    const at = Math.floor(random() * text.length);
    text = `${text.slice(0, at)}"${text.slice(at)}`;
  }
  return shape.bom ? `﻿${text}` : text;
}
