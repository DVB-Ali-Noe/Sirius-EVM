import "server-only";
import { gbdtScore, sigmoid } from "./gbdt";
import type { DeliveredModel } from "./registry";
import type { PredictionOutputKind } from "@/lib/tee/contract";

/** Sortie publiée d'une prédiction : jamais de score brut ni de probabilité. */
export interface PredictionOutput {
  outputKind: PredictionOutputKind;
  output: string;
}

/**
 * Score brut : valeur prédite (linéaire) ou log-odds de la classe 1 (logistique, arbres).
 * `orderedValues[i]` est la variable `model.features[i]`. Calculé dans le runner seulement.
 */
export function scoreModel(model: DeliveredModel, orderedValues: readonly number[]): number {
  if (orderedValues.length !== model.features.length || !orderedValues.every(Number.isFinite)) {
    throw new Error("Variables de prédiction invalides");
  }
  const score = model.algo === "gradient_boosted_trees"
    ? gbdtScore(model.baseScore, model.trees, orderedValues)
    : orderedValues.reduce((sum, value, index) => sum + value * model.coefficients[index + 1], model.coefficients[0]);
  if (!Number.isFinite(score)) throw new Error("Prédiction numérique instable");
  return score;
}

/**
 * Linéaire : valeur à 3 chiffres significatifs. Logistique : « 1 » si sigmoid(score) ≥ 0,5.
 * Arbres : « 1 » si score ≥ 0. Aucune probabilité ne sort.
 */
export function predictionOutput(model: DeliveredModel, orderedValues: readonly number[]): PredictionOutput {
  const score = scoreModel(model, orderedValues);
  if (model.algo === "linear_regression") {
    const rounded = Number(score.toPrecision(3));
    if (!Number.isFinite(rounded)) throw new Error("Prédiction numérique instable");
    return { outputKind: "value", output: String(rounded) };
  }
  const positive = model.algo === "logistic_regression" ? sigmoid(score) >= 0.5 : score >= 0;
  return { outputKind: "decision", output: positive ? "1" : "0" };
}
