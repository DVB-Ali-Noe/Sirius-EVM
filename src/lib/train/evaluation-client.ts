"use client";

import { parseCsv } from "@/lib/sirius/metrics";
import { binaryAuc, gbdtScore, sigmoid } from "@/lib/models/gbdt";
import type {
  DownloadedModel,
  GradientBoostedTreesModel,
  HistoricalLinearRegressionModel,
  LinearRegressionModel,
  LogisticRegressionModel,
} from "@/lib/models/registry";

export interface LinearModelEvaluation {
  algo: "linear_regression";
  n: number;
  r2: number;
  rmse: number;
  mae: number;
}

export interface LogisticModelEvaluation {
  algo: "logistic_regression";
  n: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface TreesModelEvaluation extends Omit<LogisticModelEvaluation, "algo"> {
  algo: "gradient_boosted_trees";
  /** `null` si le CSV de test ne contient qu'une classe. */
  auc: number | null;
}

export type ModelEvaluation = LinearModelEvaluation | LogisticModelEvaluation | TreesModelEvaluation;

export type ModelPrediction =
  | { algo: "linear_regression"; value: number }
  | { algo: "logistic_regression" | "gradient_boosted_trees"; probability: number; label: 0 | 1 };

const MIN_EVALUATION_ROWS = 20;

function numberValue(value: string | undefined, column: string): number {
  const number = Number(value);
  if (value === undefined || value.trim() === "" || !Number.isFinite(number)) {
    throw new Error(`Valeur invalide dans la colonne « ${column} »`);
  }
  return number;
}

function binaryValue(value: string | undefined, column: string): 0 | 1 {
  if (value === "0") return 0;
  if (value === "1") return 1;
  throw new Error(`La colonne « ${column} » doit être strictement encodée en 0 ou 1`);
}

/** Score brut : valeur prédite (linéaire) ou log-odds de la classe 1 (logistique, arbres). */
function score(model: DownloadedModel, values: Record<string, number>): number {
  const ordered = model.features.map((feature) => {
    const value = values[feature];
    if (!Number.isFinite(value)) throw new Error(`Valeur invalide pour « ${feature} »`);
    return value;
  });
  const prediction = model.algo === "gradient_boosted_trees"
    ? gbdtScore(model.baseScore, model.trees, ordered)
    : ordered.reduce((sum, value, index) => sum + value * model.coefficients[index + 1], model.coefficients[0]);
  if (!Number.isFinite(prediction)) throw new Error("Prédiction numérique instable");
  return prediction;
}

export function predictModel(model: LinearRegressionModel | HistoricalLinearRegressionModel, values: Record<string, number>): Extract<ModelPrediction, { algo: "linear_regression" }>;
export function predictModel(model: LogisticRegressionModel | GradientBoostedTreesModel, values: Record<string, number>): Exclude<ModelPrediction, { algo: "linear_regression" }>;
export function predictModel(model: DownloadedModel, values: Record<string, number>): ModelPrediction;
export function predictModel(model: DownloadedModel, values: Record<string, number>): ModelPrediction {
  const value = score(model, values);
  if (model.algo === "linear_regression") return { algo: model.algo, value };
  const probability = sigmoid(value);
  return { algo: model.algo, probability, label: probability >= 0.5 ? 1 : 0 };
}

export function evaluateModelCsv(model: LinearRegressionModel | HistoricalLinearRegressionModel, csv: string): LinearModelEvaluation;
export function evaluateModelCsv(model: LogisticRegressionModel, csv: string): LogisticModelEvaluation;
export function evaluateModelCsv(model: GradientBoostedTreesModel, csv: string): TreesModelEvaluation;
export function evaluateModelCsv(model: DownloadedModel, csv: string): ModelEvaluation;
export function evaluateModelCsv(model: DownloadedModel, csv: string): ModelEvaluation {
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

  const values = rows.map((row) => Object.fromEntries(
    model.features.map((feature) => [feature, numberValue(row[positions.get(feature)!], feature)]),
  ));
  if (model.algo === "linear_regression") {
    const expected = rows.map((row) => numberValue(row[positions.get(model.target)!], model.target));
    const predicted = values.map((row) => score(model, row));
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
      algo: model.algo,
      n: expected.length,
      r2: totalVariation === 0 ? 0 : 1 - squaredError / totalVariation,
      rmse: Math.sqrt(squaredError / expected.length),
      mae: absoluteError / expected.length,
    };
  }

  const expected = rows.map((row) => binaryValue(row[positions.get(model.target)!], model.target));
  const scores = values.map((row) => score(model, row));
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  for (let index = 0; index < expected.length; index++) {
    const label = sigmoid(scores[index]) >= 0.5 ? 1 : 0;
    if (label === 1 && expected[index] === 1) truePositive++;
    else if (label === 1) falsePositive++;
    else if (expected[index] === 1) falseNegative++;
    else trueNegative++;
  }
  const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
  const recall = truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);
  const classification = {
    n: expected.length,
    accuracy: (truePositive + trueNegative) / expected.length,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
  return model.algo === "gradient_boosted_trees"
    ? { algo: model.algo, ...classification, auc: binaryAuc(scores, expected) }
    : { algo: model.algo, ...classification };
}
