import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { gateModel } from "@/lib/tee/output-gate";
import { trainLinearRegression } from "@/lib/tee/train";
import { evaluateModelCsv, predictModel } from "./evaluation-client";
import type { DeliveredModel } from "./model-client";

const exactModel: DeliveredModel = {
  algo: "linear_regression",
  target: "target",
  features: ["feature"],
  coefficients: [2, 3],
  metrics: { r2: 1, rmse: 0, n: 100 },
};

test("évalue un modèle sur un CSV tenu hors de l'entraînement", () => {
  const csv = ["feature,target", ...Array.from({ length: 25 }, (_, index) => `${index},${2 + 3 * index}`)].join("\n");
  assert.equal(predictModel(exactModel, { feature: 2 }), 8);
  assert.deepEqual(evaluateModelCsv(exactModel, csv), { n: 25, r2: 1, rmse: 0, mae: 0 });
});

test("refuse un CSV de test qui ne contient pas les colonnes du modèle", () => {
  const csv = ["other,target", ...Array.from({ length: 20 }, (_, index) => `${index},${index}`)].join("\n");
  assert.throws(() => evaluateModelCsv(exactModel, csv), /mêmes features/);
});

test("évalue le modèle immobilier sur son jeu tenu à l'écart", () => {
  const model = gateModel(
    trainLinearRegression(readFileSync(resolve(process.cwd(), "public/examples/housing-prices-train.csv"))),
  ).model;
  const evaluation = evaluateModelCsv(
    model,
    readFileSync(resolve(process.cwd(), "public/examples/housing-prices-test.csv"), "utf8"),
  );

  assert.equal(evaluation.n, 28);
  assert.ok(evaluation.r2 > 0.95);
  assert.ok(evaluation.rmse < 30_000);
});

test("évalue le modèle énergie sur sa période de test chronologique", () => {
  const model = gateModel(
    trainLinearRegression(readFileSync(resolve(process.cwd(), "public/examples/energy-demand-train.csv"))),
  ).model;
  const evaluation = evaluateModelCsv(
    model,
    readFileSync(resolve(process.cwd(), "public/examples/energy-demand-test.csv"), "utf8"),
  );

  assert.equal(evaluation.n, 1_752);
  assert.ok(evaluation.r2 > 0.9);
  assert.ok(evaluation.rmse < 4);
});
