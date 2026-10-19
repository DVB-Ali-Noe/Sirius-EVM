import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { benchmarkCsv, BENCHMARK_ROWS } from "./gbdt-benchmark-csv.mjs";
import { MAX_DATASET_BYTES } from "../../src/lib/tee/contract";
import { inspectCsv } from "../../src/lib/datasets/csv-check";

test("le CSV de mesure est stable, sous la limite d'ingestion et accepté par le profil arbres", () => {
  const csv = benchmarkCsv();
  // Empreinte relevée dans le plan de session : la CVM doit recevoir exactement ce fichier.
  assert.equal(createHash("sha256").update(csv).digest("hex"), "d25689cad77668596d1d4a334b6f9913978301b6b636c5775309474b992a2c33");
  assert.ok(Buffer.byteLength(csv) < MAX_DATASET_BYTES);
  const inspection = inspectCsv(csv, "gradient_boosted_trees");
  assert.ok(inspection.ok);
  assert.equal(inspection.summary.rowCount, BENCHMARK_ROWS);
  assert.equal(inspection.summary.features.length, 23);
});
