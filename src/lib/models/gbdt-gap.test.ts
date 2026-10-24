/**
 * Audit EXA-01 : l'ancien contrôle à un sens (`trainAuc >= heldOutAuc - 0.02`) laisse passer un
 * held-out corrompu et une mémorisation ; le contrôle à deux sens les attrape, sans fausse alerte
 * sur un écart dans l'aléa. Repris de `audit/exactitude/tests/two-sided-gap.test.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { isHeldOut } from "@/lib/models/gbdt";
import { parseCsv } from "@/lib/sirius/metrics";
import { gateModel } from "@/lib/tee/output-gate";
import { trainGradientBoostedTrees } from "@/lib/tee/train-gbdt";
import { gbdtGapVerdict, heldOutClassCounts, twoSidedGapCheck } from "./gbdt-gap";

const file = resolve(process.cwd(), "public/examples/classification/credit-risk.csv");

/** Ancien contrôle, gardé ici pour montrer ce qu'il laissait passer. */
const oneSided = (trainAuc: number, heldOutAuc: number) => trainAuc >= heldOutAuc - 0.02;

function counts(csv: string): { positives: number; negatives: number } {
  const [header, ...rows] = parseCsv(csv);
  const target = header.length - 1;
  const held = rows.filter((_, row) => isHeldOut(row));
  const positives = held.filter((row) => row[target] === "1").length;
  return { positives, negatives: held.length - positives };
}

test("modèle normal : aucun signalement, et les effectifs held-out se retrouvent depuis les métriques livrées", () => {
  const text = readFileSync(file, "utf8");
  const { metrics } = gateModel(trainGradientBoostedTrees(Buffer.from(text))).model;
  const { positives, negatives } = counts(text);
  assert.equal(twoSidedGapCheck(metrics.trainAuc, metrics.heldOutAuc, positives, negatives).verdict, "ok");
  assert.deepEqual(heldOutClassCounts(metrics.n, metrics.heldOutAccuracy, metrics.heldOutPrecision, metrics.heldOutRecall), { positives, negatives });
  assert.equal(gbdtGapVerdict(metrics), "ok");
});

test("held-out corrompu (étiquettes inversées) : l'ancien contrôle passe, le contrôle à deux sens signale", () => {
  const [header, ...rows] = readFileSync(file, "utf8").trim().split(/\r?\n/);
  const flipped = [header, ...rows.map((line, row) => (isHeldOut(row) ? line.replace(/,(0|1)$/, (_, y) => `,${y === "1" ? "0" : "1"}`) : line))].join("\n");
  const { metrics } = gateModel(trainGradientBoostedTrees(Buffer.from(flipped))).model;
  const { positives, negatives } = counts(flipped);
  assert.ok(metrics.heldOutAuc < 0.35, String(metrics.heldOutAuc));
  assert.ok(oneSided(metrics.trainAuc, metrics.heldOutAuc), "l'ancien contrôle ne voit rien");
  assert.equal(twoSidedGapCheck(metrics.trainAuc, metrics.heldOutAuc, positives, negatives).verdict, "memorization");
});

test("mémorisation (train 0,99, held-out 0,75) et held-out trop beau : seul le bon sens signale", () => {
  assert.ok(oneSided(0.99, 0.75), "l'ancien contrôle accepte une mémorisation flagrante");
  assert.equal(twoSidedGapCheck(0.99, 0.75, 450, 1550).verdict, "memorization");
  assert.equal(oneSided(0.74, 0.8), false);
  assert.equal(twoSidedGapCheck(0.74, 0.8, 450, 1550).verdict, "held_out_too_good");
});

test("la marge suit la taille du held-out : 0,02 fixe est sous l'aléa à 10 000 lignes", () => {
  // 10 000 lignes : 2 000 held-out dont ~440 défauts ; AUC 0,78.
  const small = twoSidedGapCheck(0.78, 0.78, 440, 1560).se;
  // 40 000 lignes : 8 000 held-out.
  const large = twoSidedGapCheck(0.78, 0.78, 1760, 6240).se;
  assert.ok(small > 0.012 && small < 0.015, String(small));
  assert.ok(large < small / 1.9);
  // Un held-out meilleur que le train de 0,025 reste dans l'aléa (1,8 SE) : l'ancien contrôle le
  // refusait quand même (fausse alerte vue sur GMSC), le contrôle à deux sens l'accepte.
  assert.equal(oneSided(0.78, 0.805), false);
  assert.equal(twoSidedGapCheck(0.78, 0.805, 440, 1560).verdict, "ok");
});

test("sans effectif retrouvable (précision ou rappel nuls), aucun verdict plutôt qu'un verdict faux", () => {
  assert.equal(heldOutClassCounts(10_000, 0.78, 0, 0), null);
  assert.equal(gbdtGapVerdict({ trainAuc: 0.9, heldOutAuc: 0.5, heldOutAccuracy: 0.78, heldOutPrecision: 0, heldOutRecall: 0, n: 10_000 }), null);
});
