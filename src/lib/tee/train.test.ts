import assert from "node:assert/strict";
import { test } from "node:test";
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

test("borne le nombre de features avant le calcul quadratique", () => {
  const featureNames = Array.from({ length: MAX_TRAINING_FEATURES + 1 }, (_, index) => `f${index}`);
  const lines = [[...featureNames, "target"].join(",")];
  for (let row = 1; row <= 400; row++) {
    lines.push([...featureNames.map((_, index) => row + index), row * 2].join(","));
  }
  assert.throws(() => trainLinearRegression(Buffer.from(lines.join("\n"))), /trop de features/);
});
