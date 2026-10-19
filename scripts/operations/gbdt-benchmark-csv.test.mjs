import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { benchmarkCsv, BENCHMARK_ROWS } from "./gbdt-benchmark-csv.mjs";
import { MAX_DATASET_BYTES } from "../../src/lib/tee/contract";
import { inspectCsv } from "../../src/lib/datasets/csv-check";
import { trainInWorker } from "../../src/lib/tee/bounded-training";
import { modelSelection } from "../../src/lib/models/registry";

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

test("les métriques de référence de la session sont celles du runner local, à l'identique", { timeout: 30_000 }, async () => {
  // Le calcul est déterministe : la CVM doit livrer exactement ces valeurs pour ce fichier.
  const model = await trainInWorker(modelSelection("gradient_boosted_trees", "1.0.0"), Buffer.from(benchmarkCsv()), AbortSignal.timeout(25_000));
  assert.equal(model.algo, "gradient_boosted_trees");
  assert.deepEqual(
    { n: model.metrics.n, heldOutAuc: model.metrics.heldOutAuc, trainAuc: model.metrics.trainAuc, heldOutAccuracy: model.metrics.heldOutAccuracy },
    { n: 30_000, heldOutAuc: 0.8418414855712508, trainAuc: 0.8470032294457094, heldOutAccuracy: 0.7786666666666666 },
  );
});
