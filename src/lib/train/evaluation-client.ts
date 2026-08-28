"use client";

import { parseCsv } from "@/lib/sirius/metrics";
import type { DeliveredModel } from "./model-client";

export interface ModelEvaluation {
  n: number;
  r2: number;
  rmse: number;
  mae: number;
}

const MIN_EVALUATION_ROWS = 20;

function numberValue(value: string | undefined, column: string): number {
  const number = Number(value);
  if (value === undefined || value.trim() === "" || !Number.isFinite(number)) {
    throw new Error(`Valeur invalide dans la colonne « ${column} »`);
  }
  return number;
}

export function predictModel(model: DeliveredModel, values: Record<string, number>): number {
  const prediction = model.features.reduce((sum, feature, index) => {
    const value = values[feature];
    if (!Number.isFinite(value)) throw new Error(`Valeur invalide pour « ${feature} »`);
    return sum + value * model.coefficients[index + 1];
  }, model.coefficients[0]);
  if (!Number.isFinite(prediction)) throw new Error("Prédiction numérique instable");
  return prediction;
}

export function evaluateModelCsv(model: DeliveredModel, csv: string): ModelEvaluation {
  const [header, ...rows] = parseCsv(csv);
  if (!header || rows.length < MIN_EVALUATION_ROWS) {
    throw new Error(`Le CSV de test doit contenir au moins ${MIN_EVALUATION_ROWS} lignes`);
  }
  if (new Set(header).size !== header.length) throw new Error("En-têtes CSV en double");
  const positions = new Map(header.map((column, index) => [column, index]));
  const required = [...model.features, model.target];
  if (required.some((column) => positions.get(column) === undefined)) {
    throw new Error("Le CSV de test doit contenir la cible et les mêmes features");
  }

  const expected: number[] = [];
  const predicted: number[] = [];
  for (const row of rows) {
    const values = Object.fromEntries(
      model.features.map((feature) => [feature, numberValue(row[positions.get(feature)!], feature)]),
    );
    expected.push(numberValue(row[positions.get(model.target)!], model.target));
    predicted.push(predictModel(model, values));
  }

  const mean = expected.reduce((sum, value) => sum + value, 0) / expected.length;
  let squaredError = 0;
  let totalVariation = 0;
  let absoluteError = 0;
  for (let index = 0; index < expected.length; index++) {
    const error = expected[index] - predicted[index];
    squaredError += error ** 2;
    totalVariation += (expected[index] - mean) ** 2;
    absoluteError += Math.abs(error);
  }

  return {
    n: expected.length,
    r2: totalVariation === 0 ? 0 : 1 - squaredError / totalVariation,
    rmse: Math.sqrt(squaredError / expected.length),
    mae: absoluteError / expected.length,
  };
}
