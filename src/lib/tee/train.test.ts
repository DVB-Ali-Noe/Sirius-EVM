import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { gateModel } from "./output-gate";
import { MAX_TRAINING_FEATURES, MIN_TRAINING_ROWS, trainLinearRegression } from "./train";

function dataset(rows: number): Buffer {
  const lines = ["feature,target"];
  for (let index = 1; index <= rows; index++) lines.push(`${index},${index * 3 + 2}`);
  return Buffer.from(lines.join("\n"));
}

test("refuse un dataset trop petit pour éviter une inversion directe", () => {
  assert.throws(
    () => trainLinearRegression(dataset(MIN_TRAINING_ROWS - 1)),
    /dataset trop petit pour préserver la confidentialité/,
  );
});

test("accepte un dataset qui respecte le seuil de confidentialité", () => {
  const model = trainLinearRegression(dataset(MIN_TRAINING_ROWS));
  assert.equal(model.metrics.n, MIN_TRAINING_ROWS);
  assert.deepEqual(model.features, ["feature"]);
});

test("livre le modèle attendu pour le jeu immobilier de démonstration", () => {
  const model = gateModel(
    trainLinearRegression(readFileSync(resolve(process.cwd(), "public/examples/housing-prices.csv"))),
  ).model;

  assert.deepEqual(model, {
    algo: "linear_regression",
    target: "price_eur",
    features: ["surface_m2", "rooms", "age_years", "distance_km", "energy_score"],
    coefficients: [41076.6, 2941.28, 12162.4, -608.333, -4784.21, 364.224],
    metrics: { r2: 0.974095, rmse: 25392.9, n: 140 },
  });
});

test("entraîne le jeu de demande énergétique volumineux", () => {
  const model = gateModel(
    trainLinearRegression(readFileSync(resolve(process.cwd(), "public/examples/energy-demand.csv"))),
  ).model;

  assert.equal(model.metrics.n, 8_760);
  assert.ok(model.metrics.r2 > 0.95);
  assert.ok(model.metrics.rmse < 3);
});

test("borne le nombre de features avant le calcul quadratique", () => {
  const featureNames = Array.from({ length: MAX_TRAINING_FEATURES + 1 }, (_, index) => `f${index}`);
  const lines = [[...featureNames, "target"].join(",")];
  for (let row = 1; row <= 400; row++) {
    lines.push([...featureNames.map((_, index) => row + index), row * 2].join(","));
  }
  assert.throws(() => trainLinearRegression(Buffer.from(lines.join("\n"))), /trop de features/);
});
