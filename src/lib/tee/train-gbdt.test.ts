import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { trainInWorker } from "./bounded-training";
import { gateModel } from "./output-gate";
import { DatasetValidationError, trainLogisticRegression } from "./train";
import { trainGradientBoostedTrees } from "./train-gbdt";
import { parseCreateDatasetRequest } from "@/lib/datasets/create-request";
import {
  GBDT_MAX_DEPTH,
  GBDT_MIN_LEAF_ROWS,
  GBDT_MIN_ROWS,
  GBDT_TREES,
  LEAF_SIG_FIGS,
  THRESHOLD_SIG_FIGS,
  binaryAuc,
  isHeldOut,
  roundSig,
  type GbdtNode,
} from "@/lib/models/gbdt";
import { MODEL_OPTIONS, isModelOffered, modelSelection, parseDeliveredModel, type GradientBoostedTreesModel } from "@/lib/models/registry";
import { gbdtGapVerdict } from "@/lib/models/gbdt-gap";
import { parseCsv } from "@/lib/sirius/metrics";
import { predictModel } from "@/lib/train/evaluation-client";

const example = (name: string) => readFileSync(resolve(process.cwd(), `public/examples/classification/${name}`));

/** Risque à seuils et en U, sans aléa non reproductible (LCG 32 bits). */
function thresholdCsv(rows: number, features = 4, label = (row: number, risk: boolean): string => (risk ? "1" : "0")): Buffer {
  let state = 7;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  const lines = [[...Array.from({ length: features }, (_, index) => `x${index}`), "y"].join(",")];
  for (let row = 0; row < rows; row++) {
    const values = Array.from({ length: features }, () => Math.floor(next() * 100));
    const risk = (values[0] < 25 || values[0] > 75 ? 1.5 : -1) + (values[1] > 60 ? 1 : 0) + (next() - 0.5) * 2 > 0;
    lines.push([...values, label(row, risk)].join(","));
  }
  return Buffer.from(lines.join("\n"));
}

function walk(node: GbdtNode, depth: number, visit: (node: GbdtNode, depth: number) => void): void {
  visit(node, depth);
  if ("feature" in node) {
    walk(node.left, depth + 1, visit);
    walk(node.right, depth + 1, visit);
  }
}

/** Lignes d'entraînement (hors une sur cinq) atteignant chaque feuille, recomptées avec les seuils livrés. */
function leafSizes(model: GradientBoostedTreesModel, csv: Buffer): number[][] {
  const [header, ...rows] = parseCsv(csv.toString("utf8"));
  const columns = model.features.map((feature) => header.indexOf(feature));
  const training = rows.filter((_, row) => !isHeldOut(row)).map((row) => columns.map((column) => Number(row[column])));
  return model.trees.map((tree) => {
    const counts = new Map<GbdtNode, number>();
    walk(tree, 0, (node) => { if (!("feature" in node)) counts.set(node, 0); });
    for (const values of training) {
      let node = tree;
      while ("feature" in node) node = values[node.feature] < node.threshold ? node.left : node.right;
      counts.set(node, counts.get(node)! + 1);
    }
    return [...counts.values()];
  });
}

function probabilityAuc(model: Parameters<typeof predictModel>[0], csv: string): number {
  const [header, ...rows] = parseCsv(csv);
  const target = header.indexOf(model.target);
  const scores = rows.map((row) => {
    const prediction = predictModel(model, Object.fromEntries(header.map((column, index) => [column, Number(row[index])])));
    assert.ok(prediction.algo !== "linear_regression");
    return prediction.probability;
  });
  return binaryAuc(scores, rows.map((row) => Number(row[target])))!;
}

test("sur un risque à seuils, les arbres battent la logistique sur le jeu de test tenu à l'écart", () => {
  const train = example("credit-risk-train.csv");
  const testCsv = example("credit-risk-test.csv").toString("utf8");
  const trees = gateModel(trainGradientBoostedTrees(train)).model;
  const logistic = gateModel(trainLogisticRegression(train)).model;
  const treesAuc = probabilityAuc(trees, testCsv);
  const logisticAuc = probabilityAuc(logistic, testCsv);
  assert.ok(treesAuc > logisticAuc + 0.03, `arbres ${treesAuc} contre logistique ${logisticAuc}`);
  // La métrique held-out livrée annonce la même qualité que le jeu de test séparé, à l'aléa près.
  assert.ok(Math.abs(trees.metrics.heldOutAuc - treesAuc) < 0.03);
  // Écart train / held-out jugé dans les deux sens, en erreurs types du held-out (audit EXA-01).
  assert.equal(gbdtGapVerdict(trees.metrics), "ok");
  assert.equal(trees.metrics.n, 10_400);
});

test("même fichier, même modèle livré, octet pour octet", () => {
  const csv = example("credit-risk-train.csv");
  assert.ok(gateModel(trainGradientBoostedTrees(csv)).buffer.equals(gateModel(trainGradientBoostedTrees(csv)).buffer));
});

test("le modèle livré ne porte que le profil : arbres bornés, valeurs arrondies, aucun compte", () => {
  const { model, buffer } = gateModel(trainGradientBoostedTrees(example("credit-risk-train.csv")));
  assert.deepEqual(parseDeliveredModel(JSON.parse(buffer.toString("utf8"))), model);
  assert.deepEqual(Object.keys(model), ["algo", "version", "target", "features", "baseScore", "trees", "metrics"]);
  assert.ok(model.trees.length > 0 && model.trees.length <= GBDT_TREES);
  assert.ok(buffer.length < 256 * 1024);
  assert.equal(roundSig(model.baseScore, LEAF_SIG_FIGS), model.baseScore);
  let splits = 0;
  for (const tree of model.trees) {
    walk(tree, 0, (node, depth) => {
      assert.ok(depth <= GBDT_MAX_DEPTH);
      if ("feature" in node) {
        splits++;
        assert.deepEqual(Object.keys(node), ["feature", "threshold", "left", "right"]);
        assert.equal(roundSig(node.threshold, THRESHOLD_SIG_FIGS), node.threshold);
      } else {
        assert.deepEqual(Object.keys(node), ["value"]);
        assert.equal(roundSig(node.value, LEAF_SIG_FIGS), node.value);
      }
    });
  }
  assert.ok(splits > model.trees.length, "des arbres de profondeur 2 sont attendus sur ce jeu");
});

test("chaque feuille regroupe au moins 1 000 lignes d'entraînement, y compris au minimum de lignes", () => {
  for (const csv of [example("credit-risk-train.csv"), thresholdCsv(GBDT_MIN_ROWS)]) {
    const model = gateModel(trainGradientBoostedTrees(csv)).model;
    const sizes = leafSizes(model, csv).flat();
    assert.ok(sizes.every((size) => size >= GBDT_MIN_LEAF_ROWS), `plus petite feuille : ${Math.min(...sizes)}`);
  }
});

test("les seuils publiés sont des milieux entre valeurs voisines, jamais la valeur d'une ligne", () => {
  // Variables entières de 0 à 99 : un milieu entre deux entiers voisins vaut toujours x,5.
  const model = gateModel(trainGradientBoostedTrees(thresholdCsv(GBDT_MIN_ROWS))).model;
  const thresholds: number[] = [];
  for (const tree of model.trees) walk(tree, 0, (node) => { if ("feature" in node) thresholds.push(node.threshold); });
  assert.ok(thresholds.length > 0);
  assert.ok(thresholds.every((threshold) => !Number.isInteger(threshold) && Number.isInteger(threshold * 2)), thresholds.join(","));
  assert.ok(model.metrics.heldOutAuc > 0.75);
});

test("les lignes mises de côté ne servent jamais à l'entraînement", () => {
  const csv = thresholdCsv(GBDT_MIN_ROWS);
  const flipped = thresholdCsv(GBDT_MIN_ROWS, 4, (row, risk) => (isHeldOut(row) ? (risk ? "0" : "1") : risk ? "1" : "0"));
  const model = trainGradientBoostedTrees(csv);
  const other = trainGradientBoostedTrees(flipped);
  assert.deepEqual(other.trees, model.trees);
  assert.equal(other.baseScore, model.baseScore);
  assert.equal(other.metrics.trainAuc, model.metrics.trainAuc);
  assert.ok(model.metrics.heldOutAuc > 0.6 && other.metrics.heldOutAuc < 0.4);
});

test("refuse les fichiers hors profil avant tout calcul", () => {
  assert.throws(() => trainGradientBoostedTrees(thresholdCsv(9_999)), (error) =>
    error instanceof DatasetValidationError && /au moins 10 000 lignes ; utilise la régression logistique/.test(error.message));
  assert.equal(trainGradientBoostedTrees(thresholdCsv(10_000)).metrics.n, 10_000);
  assert.throws(() => trainGradientBoostedTrees(thresholdCsv(GBDT_MIN_ROWS, 4, (row) => String(row % 3))), DatasetValidationError);
  assert.throws(() => trainGradientBoostedTrees(thresholdCsv(GBDT_MIN_ROWS, 4, (row) => (isHeldOut(row) ? "1" : String(row % 2)))),
    (error) => error instanceof DatasetValidationError && /séparation/.test(error.message));
});

test("la porte de sortie refuse tout arbre hors profil, y compris un champ ajouté", () => {
  const model = trainGradientBoostedTrees(thresholdCsv(GBDT_MIN_ROWS));
  const deep: GbdtNode = { feature: 0, threshold: 1, left: { feature: 0, threshold: 1, left: { feature: 0, threshold: 1, left: { value: 0 }, right: { value: 0 } }, right: { value: 0 } }, right: { value: 0 } };
  for (const trees of [
    [{ value: 0.1, count: 1_234 } as GbdtNode],
    [deep],
    Array.from({ length: GBDT_TREES + 1 }, () => ({ value: 0 })),
    [{ feature: model.features.length, threshold: 1, left: { value: 0 }, right: { value: 0 } }],
  ]) {
    assert.throws(() => gateModel({ ...model, trees }), /hors profil/);
  }
  assert.deepEqual(gateModel({ ...model, trees: [{ value: 0.123456789 }] }).model.trees, [{ value: 0.1235 }]);
});

test("entraîne 30 000 lignes et 23 variables en worker sous le délai et la mémoire du runner", { timeout: 20_000 }, async () => {
  const csv = thresholdCsv(30_000, 23);
  assert.ok(csv.length < 3 * 1024 * 1024);
  const started = performance.now();
  const model = await trainInWorker(modelSelection("gradient_boosted_trees", "1.0.0")!, csv, AbortSignal.timeout(15_000));
  assert.ok(performance.now() - started < 15_000);
  assert.equal(model.algo, "gradient_boosted_trees");
  assert.equal(model.metrics.n, 30_000);
  assert.ok(model.metrics.heldOutAuc > 0.75);
});

test("le profil arbres n'est proposé nulle part tant que l'environnement ne l'active pas", () => {
  const previous = process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS;
  try {
    delete process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS;
    assert.equal(isModelOffered("gradient_boosted_trees"), false);
    assert.ok(isModelOffered("logistic_regression"));
    assert.ok(!MODEL_OPTIONS.some((model) => model.id === "gradient_boosted_trees"));
    const body = { name: "x", sizeBytes: 1_000, priceUsdc: "1", category: "Finance", listingDays: 30, trainingConsent: false, modelId: "gradient_boosted_trees" };
    assert.deepEqual(parseCreateDatasetRequest(body), { ok: false, status: 400, error: "Profil d’entraînement obligatoire" });
    process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS = "other, gradient_boosted_trees";
    assert.ok(isModelOffered("gradient_boosted_trees"));
    assert.ok(parseCreateDatasetRequest(body).ok);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS;
    else process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS = previous;
  }
});
