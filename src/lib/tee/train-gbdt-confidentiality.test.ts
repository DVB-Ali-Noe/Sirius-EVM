import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { gateModel } from "./output-gate";
import { DatasetValidationError, trainLogisticRegression, validateTrainingDataset } from "./train";
import { trainGradientBoostedTrees } from "./train-gbdt";
import {
  GBDT_HEADER_MESSAGE,
  GBDT_HOLDOUT_EVERY,
  GBDT_TOO_FEW_DISTINCT_ROWS_MESSAGE,
  gbdtScore,
  isHeldOut,
  thresholdBetween,
  type GbdtNode,
} from "@/lib/models/gbdt";
import { selectionForModelId, type GradientBoostedTreesModel } from "@/lib/models/registry";
import { parseCsv } from "@/lib/sirius/metrics";

/**
 * Banc de confidentialité du profil arbres (E2 minimale, audit `audit/confidentialite` du
 * 23 octobre 2026), réduit pour la CI : le même générateur de canaris et le même découpage que le
 * banc complet, sur `credit-risk.csv` (13 000 lignes, dans le dépôt), avec moins de graines.
 *
 * La mesure qui détecte la fuite est l'AUC d'appartenance canaris / témoins sur le score du
 * modèle livré : un attaquant qui possède la ligne peut-il dire si elle était dans l'entraînement ?
 * 0,5 = rien. La mesure « AUC d'appartenance par la perte » prévue à l'origine pour E2 restait à
 * 0,50 même quand des canaris ×20 étaient mémorisés à 0,8 (CONF-02) : elle n'est pas utilisée ici.
 */

const example = (name: string) => readFileSync(resolve(process.cwd(), `public/examples/classification/${name}`));

interface Dataset { header: string[]; rows: number[][] }

function loadDataset(name: string): Dataset {
  const [header, ...rows] = parseCsv(example(name).toString("utf8"));
  return { header, rows: rows.map((row) => row.map(Number)) };
}

/** Même générateur que le banc complet (xorshift 32 bits) : même graine, mêmes canaris. */
function rng(seed: number) {
  let state = (seed * 2_654_435_761) >>> 0 || 1;
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4_294_967_296;
  };
  const int = (bound: number) => Math.floor(next() * bound);
  const shuffle = <T>(items: T[]): T[] => {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  return { next, int, shuffle };
}

function toCsv(header: string[], rows: number[][]): Buffer {
  return Buffer.from([header.join(","), ...rows.map((row) => row.join(","))].join("\n"));
}

/** Place les lignes d'entraînement hors des index tenus à l'écart (i % 5 === 4) et les lignes d'écart dessus. */
function layout(train: number[][], heldOut: number[][]): number[][] {
  const needHeld = Math.floor(train.length / (GBDT_HOLDOUT_EVERY - 1));
  assert.ok(heldOut.length >= needHeld, "pas assez de lignes d'écart");
  const rows: number[][] = [];
  let t = 0;
  let h = 0;
  for (let i = 0; i < train.length + needHeld; i++) {
    if (isHeldOut(i) && h < needHeld) rows.push(heldOut[h++]);
    else if (t < train.length) rows.push(train[t++]);
    else rows.push(heldOut[h++]);
  }
  return rows;
}

/**
 * Canari « atypique » : chaque variable prise dans la marge empirique d'une colonne (valeurs
 * plausibles une à une), combinaison inédite, cible 1. Les témoins sont tirés de la même façon et
 * jamais insérés : la seule différence entre canaris et témoins est l'appartenance.
 */
function makeCanary(features: number, pool: number[][], random: ReturnType<typeof rng>): number[] {
  const row: number[] = [];
  for (let feature = 0; feature < features; feature++) row.push(pool[random.int(pool.length)][feature]);
  row.push(1);
  return row;
}

/** AUC exacte avec rangs moyens (score élevé = membre). */
function auc(positives: number[], negatives: number[]): number {
  const all = [...positives.map((s) => ({ s, y: 1 })), ...negatives.map((s) => ({ s, y: 0 }))].sort((a, b) => a.s - b.s);
  let rankSum = 0;
  for (let start = 0; start < all.length;) {
    let end = start;
    while (end + 1 < all.length && all[end + 1].s === all[start].s) end++;
    const rank = (start + end) / 2 + 1;
    for (let i = start; i <= end; i++) if (all[i].y === 1) rankSum += rank;
    start = end + 1;
  }
  return (rankSum - (positives.length * (positives.length + 1)) / 2) / (positives.length * negatives.length);
}

/** Écart-type d'une AUC nulle (Mann-Whitney, approximation normale) : 1,96 σ ≈ p = 0,05 bilatéral. */
function aucSd(positives: number, negatives: number): number {
  return Math.sqrt((positives + negatives + 1) / (12 * positives * negatives));
}

const SEEDS = 4;
const CANARIES = 50;
const MULTIPLICITY = 20;
const HELD_SLACK = 200;

interface Trial { canaryScores: number[]; controlScores: number[]; model: GradientBoostedTreesModel }

/**
 * Un entraînement par graine : canaris insérés `multiplicity` fois (`variant` transforme chaque
 * copie ; identité = copies exactes), témoins jamais insérés, le reste comme l'enclave.
 */
function trial(dataset: Dataset, seed: number, multiplicity: number, variant: (row: number[], copy: number) => number[] = (row) => row): Trial {
  const random = rng(seed * 7919 + dataset.rows.length % 97);
  const shuffled = random.shuffle(dataset.rows);
  const heldPool = shuffled.slice(0, Math.floor(shuffled.length / 5) + HELD_SLACK);
  const trainPool = shuffled.slice(heldPool.length);
  const features = dataset.header.length - 1;
  const canaries = Array.from({ length: CANARIES }, () => makeCanary(features, trainPool, random));
  const controls = Array.from({ length: CANARIES }, () => makeCanary(features, trainPool, random));
  const trainRows = trainPool.slice();
  for (const canary of canaries) for (let copy = 0; copy < multiplicity; copy++) trainRows.push(variant(canary, copy));
  const model = gateModel(trainGradientBoostedTrees(toCsv(dataset.header, layout(trainRows, heldPool)))).model;
  const score = (row: number[]) => gbdtScore(model.baseScore, model.trees, row);
  return { canaryScores: canaries.map(score), controlScores: controls.map(score), model };
}

function membershipAuc(trials: Trial[]): { auc: number; z: number } {
  const canaries = trials.flatMap((t) => t.canaryScores);
  const controls = trials.flatMap((t) => t.controlScores);
  const value = auc(canaries, controls);
  return { auc: value, z: (value - 0.5) / aucSd(canaries.length, controls.length) };
}

const creditRisk = loadDataset("credit-risk.csv");

test("CONF-01 : une ligne répétée 20 fois ne pèse pas plus qu'une ligne (k = 1) et n'est pas reconnue comme membre", { timeout: 600_000 }, (t) => {
  const repeated: Trial[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const once = trial(creditRisk, seed, 1);
    const twenty = trial(creditRisk, seed, MULTIPLICITY);
    // Mêmes arbres, même score initial : les 19 copies supplémentaires n'ont rien changé au modèle
    // (seules la tranche tenue à l'écart, plus longue avec le fichier, et `n` diffèrent).
    assert.deepEqual(twenty.model.trees, once.model.trees);
    assert.equal(twenty.model.baseScore, once.model.baseScore);
    repeated.push(twenty);
  }
  const { auc: value, z } = membershipAuc(repeated);
  const heldOut = repeated.map((trial) => trial.model.metrics.heldOutAuc);
  t.diagnostic(`canaris ×20 avec k = 1 : AUC d'appartenance ${value.toFixed(3)} (z = ${z.toFixed(2)}), AUC held-out ${Math.min(...heldOut).toFixed(3)}–${Math.max(...heldOut).toFixed(3)}`);
  // Critère de recette de l'audit : AUC canaris / témoins indiscernable de 0,5 (p > 0,05).
  assert.ok(Math.abs(z) < 1.96, `AUC d'appartenance ${value.toFixed(3)} (z = ${z.toFixed(2)}) : les lignes répétées sont encore mémorisées`);
  assert.ok(heldOut.every((auc) => auc > 0.7), `la qualité held-out a chuté : ${heldOut.join(", ")}`);
});

test("le banc détecte bien une fuite : des quasi-doublons (hors plafond par empreinte exacte) sont reconnus comme membres", { timeout: 600_000 }, (t) => {
  // Contrôle positif : chaque copie diffère de la ligne d'origine de 10⁻⁹ relatif sur la première
  // variable. Ce sont des lignes distinctes pour le plafond k = 1, mais aucun seuil publié (6 chiffres
  // au plus) ne les sépare : les arbres les mémorisent comme des copies exactes. Limite documentée du
  // plafond par empreinte ; si elle est corrigée un jour, ce contrôle positif devra changer de fuite.
  const trials: Trial[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    trials.push(trial(creditRisk, seed, MULTIPLICITY, (row, copy) => [row[0] * (1 + copy * 1e-9), ...row.slice(1)]));
  }
  const { auc: value, z } = membershipAuc(trials);
  t.diagnostic(`quasi-doublons ×20 : AUC d'appartenance ${value.toFixed(3)} (z = ${z.toFixed(2)})`);
  assert.ok(value > 0.6 && z > 3.3, `AUC d'appartenance ${value.toFixed(3)} (z = ${z.toFixed(2)}) : le banc ne voit plus une fuite connue`);
});

function thresholds(model: GradientBoostedTreesModel): Array<{ feature: number; threshold: number }> {
  const found: Array<{ feature: number; threshold: number }> = [];
  const walk = (node: GbdtNode) => {
    if (!("feature" in node)) return;
    found.push({ feature: node.feature, threshold: node.threshold });
    walk(node.left);
    walk(node.right);
  };
  for (const tree of model.trees) walk(tree);
  return found;
}

test("CONF-03 : aucun seuil livré n'est égal à une valeur du fichier, sur des décimales comme sur de grands montants", { timeout: 600_000 }, () => {
  // credit-risk : valeurs à 2 décimales (l'audit y comptait 56 seuils sur 76 égaux à une valeur présente).
  // Montants : entiers à 6 chiffres autour de 150 000, où « 158 956 | 159 008 » donnait 159 000.
  const random = rng(11);
  const amounts = [["amount", "age", "defaulted"], ...Array.from({ length: 12_000 }, () => {
    const amount = Math.round(120_000 + 60_000 * random.next() + 30_000 * (random.next() - 0.5));
    const age = 20 + random.int(50);
    return [amount, age, amount > 150_000 && age < 45 ? 1 : random.next() < 0.1 ? 1 : 0];
  })] as string[][] & number[][][];
  const cases = [
    { csv: example("credit-risk-train.csv"), label: "credit-risk-train.csv" },
    { csv: Buffer.from(amounts.map((row) => row.join(",")).join("\n")), label: "montants à 6 chiffres" },
  ];
  for (const { csv, label } of cases) {
    const [header, ...rows] = parseCsv(csv.toString("utf8"));
    const model = gateModel(trainGradientBoostedTrees(csv)).model;
    const found = thresholds(model);
    assert.ok(found.length > 0, label);
    for (const { feature, threshold } of found) {
      const column = header.indexOf(model.features[feature]);
      const values = rows.map((row) => Number(row[column]));
      assert.ok(!values.includes(threshold), `${label} : le seuil ${threshold} de ${model.features[feature]} est une valeur du fichier`);
      // Strictement entre ses deux voisines : le seuil coupe exactement où l'entraînement a coupé.
      const below = Math.max(...values.filter((value) => value < threshold));
      const above = Math.min(...values.filter((value) => value > threshold));
      assert.ok(below < threshold && threshold < above, `${label} : ${threshold} hors de ]${below} ; ${above}[`);
    }
  }
  assert.equal(thresholdBetween(158_956, 159_008), 159_000);
  assert.equal(thresholdBetween(44.79, 44.8), 44.795);
  assert.equal(thresholdBetween(1_619, 1_620), 1_619.5);
  assert.equal(thresholdBetween(5, 6), 5.5);
  assert.equal(thresholdBetween(-1, 1), 0);
  assert.equal(thresholdBetween(1, 1 + 1e-9), null, "deux valeurs trop proches : pas de coupe");
  assert.equal(thresholdBetween(2, 2), null);
});

/** CSV binaire à seuils, `features` variables entières 0–99, en-têtes personnalisables (LCG 32 bits). */
function syntheticCsv(rows: number, header: string[], distinctRows = rows): Buffer {
  let state = 7;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  const features = header.length - 1;
  const distinct: string[] = [];
  for (let row = 0; row < distinctRows; row++) {
    const values = Array.from({ length: features }, () => Math.floor(next() * 100));
    const risk = (values[0] < 25 || values[0] > 75 ? 1.5 : -1) + (values[1] > 60 ? 1 : 0) + (next() - 0.5) * 2 > 0;
    distinct.push([...values, risk ? "1" : "0"].join(","));
  }
  return Buffer.from([header.join(","), ...Array.from({ length: rows }, (_, row) => distinct[row % distinctRows])].join("\n"));
}

test("CONF-06 : les arbres refusent à l'import un nom de colonne publiée hors de [A-Za-z0-9_]{1,64} ; la logistique v1 ne change pas", () => {
  const free = syntheticCsv(10_000, ["Dossier 2024 Mme X", "x1", "y"]);
  const accent = syntheticCsv(10_000, ["revenu_€", "x1", "y"]);
  const long = syntheticCsv(10_000, ["a".repeat(65), "x1", "y"]);
  const clean = syntheticCsv(10_000, ["Revenu_2024", "x_1", "y"]);
  const refused = (error: unknown) => error instanceof DatasetValidationError && error.message === GBDT_HEADER_MESSAGE;
  for (const csv of [free, accent, long]) {
    assert.throws(() => validateTrainingDataset(csv, selectionForModelId("gradient_boosted_trees")), refused);
    assert.throws(() => trainGradientBoostedTrees(csv), refused);
    // Le format livré de la logistique v1 ne change pas (D-27) : même en-tête accepté et publié tel quel.
    assert.deepEqual(gateModel(trainLogisticRegression(csv)).model.features.length, 2);
  }
  assert.deepEqual(gateModel(trainGradientBoostedTrees(clean)).model.features, ["Revenu_2024", "x_1"]);
  // Une colonne non numérique n'est pas publiée : son nom reste libre.
  const text = Buffer.from(syntheticCsv(10_000, ["x0", "x1", "y"]).toString("utf8").split("\n").map((line, index) => (index === 0 ? `Libellé libre,${line}` : `item,${line}`)).join("\n"));
  assert.deepEqual(gateModel(trainGradientBoostedTrees(text)).model.features, ["x0", "x1"]);
});

test("k = 1 : un fichier fait de copies ne fournit pas assez de lignes distinctes et est refusé proprement", () => {
  assert.throws(() => trainGradientBoostedTrees(syntheticCsv(10_000, ["x0", "x1", "y"], 600)),
    (error) => error instanceof DatasetValidationError && error.message === GBDT_TOO_FEW_DISTINCT_ROWS_MESSAGE);
});
