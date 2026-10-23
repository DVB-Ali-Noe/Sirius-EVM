/**
 * Tests de l'audit confidentialité : constats structurels reproductibles en moins d'une minute
 * (le banc statistique complet, lui, se lance par les scripts du dossier). Les tests `todo`
 * décrivent les critères d'acceptation de l'étape E2 ; ils passeront quand elle sera codée.
 *
 *   NODE_OPTIONS=--conditions=react-server node --import tsx --test audit/confidentialite/confidentialite.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { capDuplicates, layout, loadDataset, rng, train } from "./lib";
import { analyseThresholds, summarizeThresholds } from "./thresholds";
import { confusionFromMetrics, trainAucSensitivity } from "./metadata";
import { gateModel } from "@/lib/tee/output-gate";
import { trainLogisticRegression, MAX_HEADER_CHARS } from "@/lib/tee/train";
import { isHeldOut } from "@/lib/models/gbdt";
import type { GradientBoostedTreesModel } from "@/lib/models/registry";

const creditRisk = loadDataset("credit-risk")!;
const fullFile = () => {
  const trainIdx = creditRisk.rows.map((_, i) => i).filter((i) => !isHeldOut(i));
  const heldIdx = creditRisk.rows.map((_, i) => i).filter((i) => isHeldOut(i));
  return train("gbdt", creditRisk.header, creditRisk.rows, trainIdx, heldIdx).model as GradientBoostedTreesModel;
};
let cached: GradientBoostedTreesModel | null = null;
const model = () => (cached ??= fullFile());

test("CONF : des seuils livrés sont exactement des valeurs présentes dans le fichier, et désignent des valeurs portées par une seule ligne", () => {
  const summary = summarizeThresholds(analyseThresholds(creditRisk, model()));
  // train-gbdt.ts annonce « aucune valeur d'une ligne n'est publiée telle quelle » : faux dès que
  // les valeurs ont des décimales (le milieu 44,795 arrondi à 3 chiffres redonne 44,8).
  assert.ok(summary.equalsPresentAll > 0, `aucun seuil égal à une valeur présente (${summary.thresholds} seuils)`);
  assert.ok(summary.neighbourHeldBy1Row > 0, "aucun seuil n'encadre une valeur portée par une seule ligne");
});

test("CONF : un en-tête de 128 caractères quelconques sort tel quel dans le modèle livré", () => {
  const header = `Jean Dupont né le 12/03/1980 NIR 1 80 03 75 123 456 78 tél 06 12 34 56 78 — colonne libre ${"x".repeat(40)}`.slice(0, MAX_HEADER_CHARS);
  assert.equal(header.length, MAX_HEADER_CHARS);
  const random = rng(3);
  const lines = [[header, "autre", "cible"].join(",")];
  for (let row = 0; row < 300; row++) {
    const a = random.int(100);
    const b = random.int(100);
    lines.push([a, b, a + b > 100 ? 1 : 0].join(","));
  }
  const delivered = gateModel(trainLogisticRegression(Buffer.from(lines.join("\n")))).model;
  assert.deepEqual(delivered.features, [header, "autre"]);
});

test("CONF : les métriques held-out à 6 chiffres permettent de reconstruire la matrice de confusion exacte", () => {
  const confusion = confusionFromMetrics(model());
  assert.ok(confusion.solutions >= 1);
  // Toutes les solutions compatibles donnent le même nombre de positifs dans la tranche : il est donc révélé.
  assert.equal(confusion.positivesHeldOut.length, 1, `positifs possibles : ${confusion.positivesHeldOut.join(", ")}`);
});

test("CONF : trainAuc à 6 chiffres change si une seule ligne d'entraînement est retirée ; à 3 décimales presque jamais", () => {
  const sensitivity = trainAucSensitivity(creditRisk, 150);
  assert.ok(sensitivity.changesPublishedValue6SigFigs > 0.5, `6 chiffres : ${sensitivity.changesPublishedValue6SigFigs}`);
  assert.ok(sensitivity.changesValueRoundedTo3Decimals < 0.1, `3 décimales : ${sensitivity.changesValueRoundedTo3Decimals}`);
});

test("CONF : n est publié exact", () => {
  assert.equal(model().metrics.n, creditRisk.rows.length);
});

test("banc : le découpage reproduit la règle une-sur-cinq de l'enclave", () => {
  const rows = creditRisk.rows.slice(0, 1_000);
  const placed = layout(rows.slice(0, 800), rows.slice(800));
  assert.equal(placed.rows.length, 1_000);
  assert.ok(placed.trainIdx.every((i) => !isHeldOut(i)));
  assert.ok(placed.heldOutIdx.every((i) => isHeldOut(i)));
});

test("banc : le plafond d'influence simulé garde au plus k copies d'une ligne identique", () => {
  const a = [1, 2, 1];
  const b = [3, 4, 0];
  const capped = capDuplicates([a, a, a, a, b, b], 2);
  assert.equal(capped.rows.length, 4);
  assert.equal(capped.removed, 2);
  assert.equal(capDuplicates([a, a, a], Number.POSITIVE_INFINITY).removed, 0);
});

test.todo("E2 : chaque ligne distincte pèse au plus k fois dans les gradients et les comptes de feuilles (plafond d'influence)");
test.todo("E2 : n livré arrondi (pas de centaine : 2 chiffres significatifs ou tranche) pour les nouveaux profils");
test.todo("E2 : trainAuc et métriques held-out livrées à 3 décimales au plus, jamais 6 chiffres significatifs");
test.todo("E2 : les seuils ne sont jamais égaux à une valeur présente ni à moins de 0,5 % d'une valeur portée par < 10 lignes");
test.todo("E2 : noms de colonnes limités à [A-Za-z0-9_] et 64 caractères, avec aperçu « sera publié » au fournisseur");
