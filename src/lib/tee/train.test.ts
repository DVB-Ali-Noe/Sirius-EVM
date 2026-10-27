import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { trainInWorker } from "./bounded-training";
import { gateModel } from "./output-gate";
import {
  DatasetValidationError, MAX_TRAINING_FEATURES, MAX_TRAINING_OPERATIONS, MIN_TRAINING_ROWS,
  trainingClock, trainingClockMs, trainingClockSource, trainLinearRegression, trainLogisticRegression, validateTrainingDataset,
} from "./train";
import { trainSelectedModel } from "./model-registry";
import { modelSelection } from "@/lib/models/registry";
import { translateEnglish } from "@/lib/i18n/english";

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

test("le registre runner n'accepte que les modèles et versions allowlistés", () => {
  const linear = modelSelection("linear_regression", "1.0.0");
  const logistic = modelSelection("logistic_regression", "1.0.0");
  assert.deepEqual(linear, { modelId: "linear_regression", modelVersion: "1.0.0" });
  assert.deepEqual(logistic, { modelId: "logistic_regression", modelVersion: "1.0.0" });
  assert.equal(modelSelection("gradient_boosting", "1.0.0"), null);
  assert.equal(modelSelection("linear_regression", "2.0.0"), null);
  assert.equal(trainSelectedModel(linear!, dataset(MIN_TRAINING_ROWS)).algo, "linear_regression");
  const binary = Buffer.from([
    "feature,target",
    ...Array.from({ length: MIN_TRAINING_ROWS }, (_, index) => `${index % 2},${index % 2}`),
  ].join("\n"));
  assert.equal(trainSelectedModel(logistic!, binary).algo, "logistic_regression");
});

test("livre le modèle attendu pour le jeu immobilier de démonstration", () => {
  const model = gateModel(
    trainLinearRegression(readFileSync(resolve(process.cwd(), "public/examples/regression/housing-prices.csv"))),
  ).model;

  assert.equal(model.algo, "linear_regression");
  assert.equal(model.version, "1.0.0");
  assert.equal(model.target, "price_eur");
  assert.deepEqual(model.features, ["surface_m2", "rooms", "age_years", "distance_km", "energy_score"]);
  assert.deepEqual(model.coefficients, [41076.6, 2941.28, 12162.4, -608.333, -4784.21, 364.224]);
  assert.equal(model.metrics.r2, 0.974095);
  assert.equal(model.metrics.rmse, 25392.9);
  assert.ok(model.metrics.mae > 0);
  assert.equal(model.metrics.n, 140);
});

test("entraîne le jeu de demande énergétique volumineux", () => {
  const model = gateModel(
    trainLinearRegression(readFileSync(resolve(process.cwd(), "public/examples/regression/energy-demand.csv"))),
  ).model;

  assert.equal(model.metrics.n, 8_760);
  assert.ok(model.metrics.r2 > 0.95);
  assert.ok(model.metrics.rmse < 3);
});

test("borne le nombre de features avant le calcul quadratique", () => {
  const featureNames = Array.from({ length: MAX_TRAINING_FEATURES + 1 }, (_, index) => `f${index}`);
  const lines = [[...featureNames, "target"].join(",")];
  for (let row = 1; row <= 400; row++) {
    lines.push([...featureNames.map((_, index) => row + index), row * 2].join(","));
  }
  assert.throws(() => trainLinearRegression(Buffer.from(lines.join("\n"))), /trop de features/);
});

test("entraîne une régression logistique binaire déterministe", () => {
  const lines = ["feature,target"];
  for (let row = 0; row < MIN_TRAINING_ROWS; row++) lines.push(`${row % 2},${row % 2}`);
  const model = gateModel(trainLogisticRegression(Buffer.from(lines.join("\n")))).model;

  assert.equal(model.algo, "logistic_regression");
  assert.equal(model.version, "1.0.0");
  assert.equal(model.metrics.n, MIN_TRAINING_ROWS);
  assert.ok(model.metrics.accuracy > 0.99);
  assert.ok(model.metrics.f1 > 0.99);
});

test("entraîne le jeu de défaut de crédit de démonstration", () => {
  const model = gateModel(
    trainLogisticRegression(readFileSync(resolve(process.cwd(), "public/examples/classification/credit-default-train.csv"))),
  ).model;

  assert.equal(model.algo, "logistic_regression");
  assert.deepEqual(model.features, [
    "income_k_eur",
    "debt_ratio_pct",
    "credit_score",
    "late_payments",
    "utilization_pct",
    "employment_years",
  ]);
  assert.equal(model.target, "defaulted");
  assert.equal(model.metrics.n, 480);
  assert.ok(model.metrics.accuracy > 0.7);
  assert.ok(model.metrics.accuracy < 0.9);
  assert.ok(model.metrics.f1 > 0.5);
  assert.ok(model.metrics.f1 < 0.8);
});

test("refuse une cible logistique qui n'est pas strictement binaire", () => {
  const lines = ["feature,target"];
  for (let row = 0; row < MIN_TRAINING_ROWS; row++) lines.push(`${row},${row % 3}`);
  assert.throws(
    () => trainLogisticRegression(Buffer.from(lines.join("\n"))),
    /strictement 0 ou 1/,
  );
});

test("une erreur imputable au fichier est distinguable d'une panne technique", () => {
  // Ce que ce test protège : à l'upload, ces motifs remontent en 400 avec leur message ;
  // pendant un entraînement ils restent opaques. La distinction ne tient qu'au type, donc
  // repasser l'un d'eux en `Error` nu redonnerait « Internal error » à l'utilisateur sans
  // qu'aucun autre test ne s'en aperçoive.
  const binaire = ["feature,target"];
  for (let row = 0; row < MIN_TRAINING_ROWS; row++) binaire.push(`${row},${row % 3}`);

  const cas: [string, () => unknown][] = [
    ["cible logistique non binaire", () =>
      validateTrainingDataset(Buffer.from(binaire.join("\n")), modelSelection("logistic_regression", "1.0.0")!)],
    ["dataset trop court", () => trainLinearRegression(dataset(MIN_TRAINING_ROWS - 1))],
    ["en-têtes dupliqués", () => trainLinearRegression(Buffer.from("a,a\n1,2\n3,4"))],
  ];

  for (const [nom, appel] of cas) {
    assert.throws(appel, (error: unknown) => {
      assert.ok(error instanceof DatasetValidationError, `${nom} : type attendu DatasetValidationError`);
      return true;
    });
  }
});

test("chaque motif de validation a une traduction anglaise", () => {
  // Le message traverse le runner puis `errorResponse` avant d'atteindre l'écran. S'il n'est
  // pas dans le dictionnaire, l'utilisateur lit du français au milieu d'une interface anglaise.
  const motifs = [
    "dataset insuffisant",
    "en-têtes CSV invalides",
    "au moins 2 colonnes numériques requises",
    "colonne cible non numérique",
    "la cible de la régression logistique doit contenir les classes 0 et 1",
    `trop de features numériques (max ${MAX_TRAINING_FEATURES})`,
    `dataset trop petit pour préserver la confidentialité (min ${MIN_TRAINING_ROWS} lignes)`,
  ];
  for (const motif of motifs) {
    assert.notEqual(translateEnglish(motif), motif, `motif non traduit : ${motif}`);
  }
});

test("le budget élargi admet 30 000 lignes et refuse la première logistique hors limite", () => {
  const header = Array.from({ length: 32 }, (_, index) => `f${index}`).join(",");
  const rows = Math.floor(MAX_TRAINING_OPERATIONS / (32 * 200));
  const csv = Buffer.from([header, ...Array.from({ length: rows + 1 }, (_, index) => Array(32).fill(index % 2).join(","))].join("\n"));
  assert.ok(csv.length < 3 * 1024 * 1024);
  const selection = modelSelection("logistic_regression", "1.0.0")!;
  const accepted = csv.subarray(0, csv.lastIndexOf("\n"));
  validateTrainingDataset(accepted, selection);
  assert.throws(
    () => validateTrainingDataset(csv, selection),
    (error) => error instanceof DatasetValidationError && /budget de calcul/.test(error.message),
  );
});

test("entraîne 30 000 lignes en worker sans épuiser son délai ni sa mémoire", { timeout: 20_000 }, async () => {
  const header = Array.from({ length: 24 }, (_, index) => `f${index}`).join(",");
  const data = Array.from({ length: 30_000 }, (_, index) => [
    index % 2,
    ...Array.from({ length: 22 }, (_, feature) => String((index * 37 + feature * 71) % 1000).padStart(3, "0")),
    index % 2,
  ].join(","));
  const csv = Buffer.from([header, ...data].join("\n"));
  assert.ok(csv.length < 3 * 1024 * 1024);
  const model = await trainInWorker(modelSelection("logistic_regression", "1.0.0")!, csv, AbortSignal.timeout(15_000));
  assert.equal(model.algo, "logistic_regression");
  assert.equal(model.metrics.n, 30_000);
  assert.ok(model.metrics.accuracy > 0.9);
});

test("EXA-05 : le délai d'entraînement se mesure en temps CPU du thread quand la source le fournit", () => {
  // Horloge CPU : microsecondes user + system, rendues en millisecondes.
  let cpu = { user: 2_000_000, system: 500_000 };
  const clock = trainingClock({ threadCpuUsage: () => cpu });
  assert.equal(clock(), 2_500);
  const deadline = clock() + 15_000;
  // Machine chargée : le temps réel avance, mais le thread n'a pas eu le processeur ; l'échéance n'est pas atteinte.
  assert.ok(clock() <= deadline);
  cpu = { user: 17_000_000, system: 600_000 };
  assert.ok(clock() > deadline);
  // La méthode est appelée sur sa source, comme `process.threadCpuUsage` sur `process`.
  const source = { calls: 0, threadCpuUsage(this: { calls: number }) { this.calls++; return { user: 1_000, system: 0 }; } };
  assert.equal(trainingClock(source)(), 1);
  assert.equal(source.calls, 1);
});

test("EXA-05 : sans threadCpuUsage, le délai se mesure en temps réel, comme avant", () => {
  // Absence forcée par injection : vrai quelle que soit la version de Node qui exécute le test.
  const wall = trainingClock({});
  const before = performance.now();
  const read = wall();
  assert.ok(read >= before && read <= performance.now());
});

test("EXA-05 : l'horloge du délai suit process.threadCpuUsage quand Node la fournit (Node 22.23 de la CI), sinon le temps réel", () => {
  const nodeCpu = (process as unknown as { threadCpuUsage?: () => { user: number; system: number } }).threadCpuUsage;
  const reference = typeof nodeCpu === "function"
    ? () => { const { user, system } = nodeCpu.call(process); return (user + system) / 1_000; }
    : () => performance.now();
  assert.equal(typeof trainingClockSource.threadCpuUsage, typeof nodeCpu);
  const before = reference();
  const read = trainingClockMs();
  assert.ok(read >= before && read <= reference(), `${read} hors de [${before}, …]`);
});

const hasThreadCpuClock = typeof (process as unknown as { threadCpuUsage?: unknown }).threadCpuUsage === "function";

test("EXA-05 : une attente hors CPU ne consomme pas le délai", { skip: hasThreadCpuClock ? false : "process.threadCpuUsage absent de cette version de Node" }, async () => {
  const started = trainingClockMs();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(trainingClockMs() - started < 150);
});
