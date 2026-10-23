/**
 * Pilote d'audit : entraîne le profil Sirius sur un CSV et écrit les prédictions en JSON.
 *
 * Usage (depuis la racine du dépôt) :
 *   NODE_OPTIONS="--conditions=react-server" node --import tsx audit/exactitude/sirius-run.ts <train.csv> <sortie.json> [test.csv]
 *
 * - Arbres : `trainGradientBoostedTrees` + `gateModel` (exactement le chemin de l'enclave), puis le
 *   buffer livré est relu par `parseDeliveredModel` et prédit par `predictModel` (chemin du navigateur).
 * - Logistique « actuelle » : `trainLogisticRegression` entraînée sur les seules lignes d'entraînement
 *   du split Sirius (index % 5 !== 4), pour la comparer aux arbres sur les mêmes lignes held-out.
 * - Si `test.csv` est donné, les deux modèles sont aussi évalués sur ce fichier externe.
 * Aucun réseau, aucune clé : calcul pur.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gateModel } from "@/lib/tee/output-gate";
import { trainLogisticRegression } from "@/lib/tee/train";
import { trainGradientBoostedTrees } from "@/lib/tee/train-gbdt";
import { isHeldOut } from "@/lib/models/gbdt";
import { parseDeliveredModel, type DeliveredModel } from "@/lib/models/registry";
import { parseCsv } from "@/lib/sirius/metrics";
import { predictModel } from "@/lib/train/evaluation-client";

const [trainPath, outPath, testPath] = process.argv.slice(2);
if (!trainPath || !outPath) throw new Error("usage : sirius-run.ts <train.csv> <sortie.json> [test.csv]");

const csv = readFileSync(trainPath);
const [header, ...rows] = parseCsv(csv.toString("utf8"));

function probabilities(model: DeliveredModel, table: string[][], columns: string[]): number[] {
  const index = new Map(columns.map((column, position) => [column, position]));
  return table.map((row) => {
    const values = Object.fromEntries(model.features.map((feature) => [feature, Number(row[index.get(feature)!])]));
    const prediction = predictModel(model, values);
    if (prediction.algo === "linear_regression") throw new Error("modèle inattendu");
    return prediction.probability;
  });
}

const result: Record<string, unknown> = { file: trainPath, rows: rows.length };
const started = performance.now();
let trees: DeliveredModel | null = null;
try {
  const gated = gateModel(trainGradientBoostedTrees(csv));
  result.treesMs = Math.round(performance.now() - started);
  result.sha256 = createHash("sha256").update(gated.buffer).digest("hex");
  result.bytes = gated.buffer.length;
  trees = parseDeliveredModel(JSON.parse(gated.buffer.toString("utf8")));
  if (trees.algo !== "gradient_boosted_trees") throw new Error("profil inattendu");
  result.features = trees.features;
  result.target = trees.target;
  result.treesMetrics = trees.metrics;
  result.treeCount = trees.trees.length;
} catch (error) {
  result.treesError = String(error instanceof Error ? error.message : error);
  result.treesMs = Math.round(performance.now() - started);
}

const target = trees?.target ?? header[header.length - 1];
const targetIndex = header.indexOf(target);
const trainTable = rows.filter((_, row) => !isHeldOut(row));
const heldOutTable = rows.filter((_, row) => isHeldOut(row));
result.heldOutY = heldOutTable.map((row) => Number(row[targetIndex]));
result.trainY = trainTable.map((row) => Number(row[targetIndex]));

let logistic: DeliveredModel | null = null;
const logisticStarted = performance.now();
try {
  const trainCsv = Buffer.from([header, ...trainTable].map((row) => row.join(",")).join("\n"));
  logistic = parseDeliveredModel(JSON.parse(gateModel(trainLogisticRegression(trainCsv, target)).buffer.toString("utf8")));
  result.logisticMs = Math.round(performance.now() - logisticStarted);
  result.logisticFeatures = logistic.features;
  result.logisticMetricsInSample = logistic.metrics;
} catch (error) {
  result.logisticError = String(error instanceof Error ? error.message : error);
}

if (trees) {
  result.treesHeldOut = probabilities(trees, heldOutTable, header);
  result.treesTrain = probabilities(trees, trainTable, header);
}
if (logistic) {
  result.logisticHeldOut = probabilities(logistic, heldOutTable, header);
  result.logisticTrain = probabilities(logistic, trainTable, header);
}

if (testPath) {
  const [testHeader, ...testRows] = parseCsv(readFileSync(testPath, "utf8"));
  result.testY = testRows.map((row) => Number(row[testHeader.indexOf(target)]));
  if (trees) result.treesTest = probabilities(trees, testRows, testHeader);
  if (logistic) result.logisticTest = probabilities(logistic, testRows, testHeader);
}

writeFileSync(outPath, JSON.stringify(result));
console.log(JSON.stringify({
  file: trainPath,
  rows: rows.length,
  treesMs: result.treesMs,
  treesError: result.treesError,
  logisticError: result.logisticError,
  features: (result.features as string[] | undefined)?.length,
  metrics: result.treesMetrics,
}));
