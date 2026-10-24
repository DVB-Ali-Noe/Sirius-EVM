import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { benchmarkCsv, BENCHMARK_ROWS } from "./gbdt-benchmark-csv.mjs";
import { MAX_DATASET_BYTES } from "../../src/lib/tee/contract";
import { inspectCsv } from "../../src/lib/datasets/csv-check";
import { trainInWorker } from "../../src/lib/tee/bounded-training";
import { gateModel } from "../../src/lib/tee/output-gate";
import { modelSelection } from "../../src/lib/models/registry";

/** Métriques livrées (après la porte de sortie) par le profil 1.1.0 sur le CSV de mesure, relevées le 24 octobre 2026. */
const GBDT_1_1_0_REFERENCE = { n: 30_000, heldOutAuc: 0.842, aucGap: 0.01, heldOutAccuracy: 0.779 };

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
  // Profil 1.0.0 (session staging du 20 octobre) : heldOutAuc 0.8418414855712508, trainAuc 0.8470032294457094,
  // heldOutAccuracy 0.7786666666666666, métriques brutes. Le profil 1.1.0 (E2 minimale) livre les métriques
  // arrondies et l'écart d'AUC à la place du trainAuc : la référence ci-dessous est celle de ce profil.
  // Le worker rend le modèle brut ; l'acheteur reçoit ce que la porte de sortie en garde
  // (`sealTrainedModel` dans `core.ts`, sur tous les chemins de livraison) : on compare celui-là.
  const trained = await trainInWorker(modelSelection("gradient_boosted_trees", "1.1.0"), Buffer.from(benchmarkCsv()), AbortSignal.timeout(25_000));
  const { model } = gateModel(trained);
  assert.equal(model.algo, "gradient_boosted_trees");
  assert.deepEqual(
    { n: model.metrics.n, heldOutAuc: model.metrics.heldOutAuc, aucGap: model.metrics.aucGap, heldOutAccuracy: model.metrics.heldOutAccuracy },
    GBDT_1_1_0_REFERENCE,
  );
});
