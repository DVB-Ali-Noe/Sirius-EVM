/**
 * Q2 : les prédictions du navigateur (evaluation-client.ts) égalent celles du modèle livré, ligne par ligne.
 *
 * Référence « enclave » : le modèle tel que `trainGradientBoostedTrees` le renvoie (avant l'output-gate),
 * parcouru par une implémentation indépendante (pas `gbdtScore`). Chemin « navigateur » : buffer livré par
 * `gateModel` → JSON → `parseDeliveredModel` → `predictModel` / `evaluateModelCsv`.
 *
 * Lancer : NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/exactitude/tests/browser-vs-enclave.test.ts
 * Les jeux OpenML (audit/exactitude/.data/*.csv) sont utilisés s'ils existent (voir prepare_data.py).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { isHeldOut, type GbdtNode } from "@/lib/models/gbdt";
import { parseDeliveredModel, type GradientBoostedTreesModel } from "@/lib/models/registry";
import { parseCsv } from "@/lib/sirius/metrics";
import { gateModel } from "@/lib/tee/output-gate";
import { trainGradientBoostedTrees } from "@/lib/tee/train-gbdt";
import { evaluateModelCsv, predictModel } from "@/lib/train/evaluation-client";

const TOLERANCE = 1e-6;
const files = [
  resolve(process.cwd(), "public/examples/classification/credit-risk.csv"),
  resolve(process.cwd(), "audit/exactitude/.data/taiwan.csv"),
  resolve(process.cwd(), "audit/exactitude/.data/gmsc.csv"),
].filter((file) => existsSync(file));

function referenceProbability(model: GradientBoostedTreesModel, values: number[]): number {
  let score = model.baseScore;
  for (const tree of model.trees) {
    let node: GbdtNode = tree;
    for (;;) {
      if (!("feature" in node)) break;
      node = values[node.feature] < node.threshold ? node.left : node.right;
    }
    score += (node as { value: number }).value;
  }
  return 1 / (1 + Math.exp(-score));
}

for (const file of files) {
  test(`navigateur = enclave ligne par ligne (${file.split(/[\\/]/).pop()})`, (t) => {
    const csv = readFileSync(file);
    const trained = trainGradientBoostedTrees(csv);
    const { buffer } = gateModel(trained);
    const delivered = parseDeliveredModel(JSON.parse(buffer.toString("utf8")));
    assert.equal(delivered.algo, "gradient_boosted_trees");
    if (delivered.algo !== "gradient_boosted_trees") return;
    // L'output-gate ne change rien aux arbres : seuils et feuilles sont déjà arrondis à l'entraînement.
    assert.deepEqual(delivered.trees, trained.trees);
    assert.equal(delivered.baseScore, trained.baseScore);

    const [header, ...rows] = parseCsv(csv.toString("utf8"));
    const columns = delivered.features.map((feature) => header.indexOf(feature));
    let maxDifference = 0;
    let labelMismatches = 0;
    for (const row of rows) {
      const values = columns.map((column) => Number(row[column]));
      const expected = referenceProbability(trained, values);
      const browser = predictModel(delivered, Object.fromEntries(delivered.features.map((feature, index) => [feature, values[index]])));
      maxDifference = Math.max(maxDifference, Math.abs(browser.probability - expected));
      if (browser.label !== (expected >= 0.5 ? 1 : 0)) labelMismatches++;
    }
    t.diagnostic(`lignes=${rows.length} écart max=${maxDifference} étiquettes différentes=${labelMismatches}`);
    assert.ok(maxDifference <= TOLERANCE, `écart max ${maxDifference}`);
    assert.equal(labelMismatches, 0);

    // Les lignes held-out, évaluées dans le navigateur, redonnent les métriques livrées.
    const heldOutCsv = [header, ...rows.filter((_, row) => isHeldOut(row))].map((row) => row.join(",")).join("\n");
    const evaluation = evaluateModelCsv(delivered, heldOutCsv);
    const metrics = delivered.metrics;
    const gaps = {
      auc: Math.abs(evaluation.auc! - metrics.heldOutAuc),
      accuracy: Math.abs(evaluation.accuracy - metrics.heldOutAccuracy),
      precision: Math.abs(evaluation.precision - metrics.heldOutPrecision),
      recall: Math.abs(evaluation.recall - metrics.heldOutRecall),
      f1: Math.abs(evaluation.f1 - metrics.heldOutF1),
    };
    t.diagnostic(`écarts métriques held-out navigateur/livrées=${JSON.stringify(gaps)}`);
    for (const [name, gap] of Object.entries(gaps)) assert.ok(gap <= TOLERANCE, `${name} : ${gap}`);
  });
}

test("une valeur égale au seuil part à droite des deux côtés, quelle que soit son écriture", () => {
  const model = parseDeliveredModel(JSON.parse(gateModel(trainGradientBoostedTrees(readFileSync(files[0]))).buffer.toString("utf8")));
  if (model.algo !== "gradient_boosted_trees") throw new Error("profil inattendu");
  const root = model.trees.find((tree) => "feature" in tree) as Extract<GbdtNode, { feature: number }>;
  const feature = model.features[root.feature];
  const base = Object.fromEntries(model.features.map((name) => [name, 0]));
  const atThreshold = predictModel(model, { ...base, [feature]: root.threshold }).probability;
  const reference = referenceProbability(model, model.features.map((name) => (name === feature ? root.threshold : 0)));
  assert.equal(atThreshold, reference);
  // « 1e3 », « 1000.0 » et « 1000 » donnent le même nombre dans le CSV de test du navigateur et dans l'enclave.
  const header = [...model.features, model.target].join(",");
  const line = (value: string) => [...model.features.map((name) => (name === feature ? value : "0")), "0"].join(",");
  const written = String(root.threshold);
  const variants = [written, `${written}0`, Number(written).toExponential()];
  const scores = variants.map((value) => evaluateModelCsv(model, [header, ...Array.from({ length: 20 }, (_, i) => (i === 0 ? line(value) : line(value).replace(/0$/, "1")))].join("\n")).accuracy);
  assert.equal(new Set(scores).size, 1);
});
