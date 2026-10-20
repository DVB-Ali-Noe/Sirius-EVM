import assert from "node:assert/strict";
import { test } from "node:test";
import { computeMetrics, CsvValidationError, MAX_CSV_COLUMNS, MAX_CSV_ROWS, parseCsv, publicDatasetMetrics } from "./metrics";

test("ne publie que les volumes globaux du dataset", () => {
  const metrics = computeMetrics(Buffer.from("patient_id,salary\np-001,123456\n"));

  assert.deepEqual(metrics, { rowCount: 1, columnCount: 2 });
});

test("retire les statistiques détaillées des datasets historiques", () => {
  const metrics = publicDatasetMetrics({
    rowCount: 1,
    columnCount: 2,
    columns: [
      { name: "patient_id", type: "string", distinct: 1 },
      { name: "salary", type: "number", min: 123456, max: 123456, mean: 123456 },
    ],
  });

  assert.deepEqual(metrics, { rowCount: 1, columnCount: 2 });
});

test("rejette les métriques publiques hors bornes", () => {
  assert.deepEqual(publicDatasetMetrics({ rowCount: MAX_CSV_ROWS, columnCount: 2 }), { rowCount: MAX_CSV_ROWS, columnCount: 2 });
  assert.equal(publicDatasetMetrics({ rowCount: MAX_CSV_ROWS + 1, columnCount: 2 }), null);
});

test("les limites CSV acceptent la borne et rejettent son dépassement avec une erreur typée", () => {
  assert.equal(parseCsv(Array(MAX_CSV_COLUMNS).fill("x").join(","))[0].length, MAX_CSV_COLUMNS);
  assert.throws(() => parseCsv(Array(MAX_CSV_COLUMNS + 1).fill("x").join(",")), CsvValidationError);

  assert.equal(parseCsv("x\n".repeat(MAX_CSV_ROWS)).length, MAX_CSV_ROWS);
  assert.throws(() => parseCsv("x\n".repeat(MAX_CSV_ROWS + 1)), CsvValidationError);

  assert.equal(parseCsv("x".repeat(10_000))[0][0].length, 10_000);
  assert.throws(() => parseCsv("x".repeat(10_001)), CsvValidationError);
  assert.throws(() => parseCsv(`"${'""'.repeat(10_001)}"`), CsvValidationError);
});
