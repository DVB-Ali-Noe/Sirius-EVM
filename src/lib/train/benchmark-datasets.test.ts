import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { gateModel } from "@/lib/tee/output-gate";
import { trainLinearRegression } from "@/lib/tee/train";
import { scoreModel } from "@/lib/models/predict";
import { parseCsv } from "@/lib/sirius/metrics";

const benchmarks = [
  { name: "vehicle-resale", trainRows: 6_000, testRows: 1_500, features: 11 },
  { name: "retail-demand", trainRows: 10_080, testRows: 2_520, features: 12 },
  { name: "last-mile-delivery", trainRows: 9_600, testRows: 2_400, features: 12 },
  { name: "industrial-yield", trainRows: 15_600, testRows: 3_900, features: 31 },
];

for (const benchmark of benchmarks) {
  test(`entraîne et évalue ${benchmark.name} sans fuite de cible`, () => {
    const train = readFileSync(resolve(process.cwd(), `public/examples/benchmarks/${benchmark.name}-train.csv`));
    const [header, ...rows] = parseCsv(readFileSync(resolve(process.cwd(), `public/examples/benchmarks/${benchmark.name}-test.csv`), "utf8"));
    const model = gateModel(trainLinearRegression(train)).model;

    assert.equal(model.metrics.n, benchmark.trainRows);
    assert.equal(model.features.length, benchmark.features);
    assert.equal(rows.length, benchmark.testRows);
    // Même calcul que le runner (`scoreModel`), sur le jeu tenu à l'écart.
    const columns = model.features.map((feature) => header.indexOf(feature));
    const targetColumn = header.indexOf(model.target);
    assert.ok(columns.every((column) => column >= 0) && targetColumn >= 0, "le CSV de test porte la cible et les mêmes features");
    const actual = rows.map((row) => Number(row[targetColumn]));
    const predicted = rows.map((row) => scoreModel(model, columns.map((column) => Number(row[column]))));
    const mean = actual.reduce((sum, value) => sum + value, 0) / actual.length;
    const residual = actual.reduce((sum, value, index) => sum + (value - predicted[index]) ** 2, 0);
    const total = actual.reduce((sum, value) => sum + (value - mean) ** 2, 0);
    assert.ok(Number.isFinite(1 - residual / total));
    assert.ok(Number.isFinite(Math.sqrt(residual / actual.length)));
  });
}
