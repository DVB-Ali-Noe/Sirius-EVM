/**
 * Q4 : le contrôle actuel à un sens laisse passer un held-out corrompu ; le contrôle à deux sens l'attrape.
 *
 * Lancer : NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/exactitude/tests/two-sided-gap.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { isHeldOut } from "@/lib/models/gbdt";
import { parseCsv } from "@/lib/sirius/metrics";
import { gateModel } from "@/lib/tee/output-gate";
import { trainGradientBoostedTrees } from "@/lib/tee/train-gbdt";
import { currentOneSidedCheck, heldOutClassCounts, twoSidedGapCheck } from "../two-sided-gap";

const file = resolve(process.cwd(), "public/examples/classification/credit-risk.csv");

function counts(csv: string): { positives: number; negatives: number } {
  const [header, ...rows] = parseCsv(csv);
  const target = header.length - 1;
  const held = rows.filter((_, row) => isHeldOut(row));
  const positives = held.filter((row) => row[target] === "1").length;
  return { positives, negatives: held.length - positives };
}

test("modèle normal : les deux contrôles passent, et les effectifs se retrouvent depuis les métriques livrées", () => {
  const text = readFileSync(file, "utf8");
  const { metrics } = gateModel(trainGradientBoostedTrees(Buffer.from(text))).model;
  const { positives, negatives } = counts(text);
  assert.ok(currentOneSidedCheck(metrics.trainAuc, metrics.heldOutAuc));
  assert.equal(twoSidedGapCheck(metrics.trainAuc, metrics.heldOutAuc, positives, negatives).verdict, "ok");
  assert.deepEqual(heldOutClassCounts(metrics.n, metrics.heldOutAccuracy, metrics.heldOutPrecision, metrics.heldOutRecall), { positives, negatives });
});

test("held-out corrompu (étiquettes inversées) : le contrôle actuel passe, le contrôle à deux sens alerte", () => {
  const [header, ...rows] = readFileSync(file, "utf8").trim().split(/\r?\n/);
  const flipped = [header, ...rows.map((line, row) => (isHeldOut(row) ? line.replace(/,(0|1)$/, (_, y) => `,${y === "1" ? "0" : "1"}`) : line))].join("\n");
  const { metrics } = gateModel(trainGradientBoostedTrees(Buffer.from(flipped))).model;
  const { positives, negatives } = counts(flipped);
  assert.ok(metrics.heldOutAuc < 0.35, String(metrics.heldOutAuc));
  assert.ok(currentOneSidedCheck(metrics.trainAuc, metrics.heldOutAuc), "le contrôle actuel ne voit rien");
  assert.equal(twoSidedGapCheck(metrics.trainAuc, metrics.heldOutAuc, positives, negatives).verdict, "memorization");
});

test("mémorisation (train 0,99, held-out 0,75) et held-out trop beau : seuls les bons sens alertent", () => {
  assert.ok(currentOneSidedCheck(0.99, 0.75), "le contrôle actuel accepte une mémorisation flagrante");
  assert.equal(twoSidedGapCheck(0.99, 0.75, 450, 1550).verdict, "memorization");
  assert.equal(currentOneSidedCheck(0.74, 0.8), false);
  assert.equal(twoSidedGapCheck(0.74, 0.8, 450, 1550).verdict, "held_out_too_good");
});

test("la marge suit la taille du held-out : 0,02 fixe est sous l'aléa à 10 000 lignes", () => {
  // 10 000 lignes : 2 000 held-out dont ~440 défauts ; AUC 0,78.
  const small = twoSidedGapCheck(0.78, 0.78, 440, 1560).se;
  // 40 000 lignes : 8 000 held-out.
  const large = twoSidedGapCheck(0.78, 0.78, 1760, 6240).se;
  assert.ok(small > 0.012 && small < 0.015, String(small));
  assert.ok(large < small / 1.9);
  // À 10 000 lignes, un held-out meilleur que le train de 0,025 reste dans l'aléa (1,8 SE) : le contrôle actuel
  // le refuse quand même ; le contrôle à deux sens l'accepte.
  assert.equal(currentOneSidedCheck(0.78, 0.805), false);
  assert.equal(twoSidedGapCheck(0.78, 0.805, 440, 1560).verdict, "ok");
});
