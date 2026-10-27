import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { selectionForModelId } from "@/lib/models/registry";
import { trainingColumns, validateTrainingDataset } from "@/lib/tee/train";
import { parseCsv } from "@/lib/sirius/metrics";
import { inspectCsvTable, readCsvTable } from "./csv-check";
import { MIN_MINORITY_CLASS_SHARE, TARGET_COPY_MIN_ABS_CORRELATION, hasQualitySignal, qualityReport } from "./quality";

/** CSV synthétique sans défaut : variables non corrélées entre elles ni à la cible, aucune ligne répétée. */
function rows(count: number, cells: (row: number) => string[]): string[][] {
  return Array.from({ length: count }, (_, row) => cells(row));
}
const clean = (row: number) => [String(row), String((row * 37) % 101), String((row * 53) % 97), String(row % 2)];
const HEADER = ["id", "a", "b", "y"];

function report(header: string[], body: string[][]) {
  const result = qualityReport([header, ...body]);
  assert.ok(result);
  return result;
}

test("un fichier propre ne déclenche aucun signalement ; un fichier sans ligne de données n'a pas de rapport", () => {
  const result = report(HEADER, rows(400, clean));
  assert.equal(hasQualitySignal(result), false);
  assert.deepEqual(result.classBalance, { zeros: 200, ones: 200, minorityShare: 0.5, imbalanced: false });
  assert.equal(qualityReport(parseCsv("a,y\n")), null);
});

test("EXA-03 : une dernière colonne presque numérique est refusée, au lieu de changer la cible en silence", () => {
  const body = rows(400, (row) => [...clean(row).slice(0, 3), row === 7 ? "" : row === 9 ? "n/a" : String(row % 2)]);
  const result = report(HEADER, body);
  assert.equal(result.targetShift, null);
  assert.deepEqual(result.excluded, [{ column: "y", missing: 1, invalid: 1 }]);
  const inspection = inspectCsvTable({ ok: true, table: [HEADER, ...body] }, "linear_regression");
  assert.ok(!inspection.ok);
  assert.deepEqual(inspection.reason, { kind: "incomplete-target", target: "y", missing: 1, invalid: 1 });
  const csv = Buffer.from([HEADER, ...body].map((line) => line.join(",")).join("\n"));
  assert.throws(() => validateTrainingDataset(csv, selectionForModelId("linear_regression")), /la dernière colonne « y » sert de cible .*\(1 cellule\(s\) vide\(s\), 1 non numérique\(s\)\)/);
  // Hors ingestion, un dataset déjà publié garde sa lecture : même choix de cible et de variables qu'avant.
  const enclave = trainingColumns(csv, undefined, Infinity);
  assert.equal(enclave.header[enclave.targetIdx], "b");
});

test("une dernière colonne de texte fait changer la cible : signalé avec les deux noms, sans refus", () => {
  const body = rows(400, (row) => [...clean(row), `note ${row}`]);
  const result = report([...HEADER, "commentaire"], body);
  assert.deepEqual(result.targetShift, { expected: "commentaire", actual: "y" });
  assert.deepEqual(result.textColumns, ["commentaire"]);
  const inspection = inspectCsvTable({ ok: true, table: [[...HEADER, "commentaire"], ...body] }, "linear_regression");
  assert.ok(inspection.ok);
  assert.equal(inspection.summary.target, "y");
});

test("valeurs manquantes et invalides : comptées seulement pour une colonne qui serait numérique sans elles", () => {
  const header = ["note", "a", "short", "y"];
  const body = rows(400, (row) => {
    const cells = [`texte ${row}`, row % 50 === 0 ? "n/a" : String((row * 37) % 101), String((row * 53) % 97), String(row % 2)];
    return row === 10 ? cells.slice(0, 2) : cells; // ligne courte : « short » et « y » absents
  });
  const result = report(header, body);
  assert.deepEqual(result.textColumns, ["note"]);
  assert.deepEqual(result.excluded, [
    { column: "a", missing: 0, invalid: 8 },
    { column: "short", missing: 1, invalid: 0 },
    { column: "y", missing: 1, invalid: 0 },
  ]);
  // Mêmes colonnes d'entraînement que l'enclave : aucune ici, donc le contrôle refuse, mais le rapport existe.
  assert.equal(result.targetShift, null);
  assert.deepEqual(result.duplicates, { rows: 0, maxRepeat: 0 });
  // Avec la cible seule pour colonne numérique, sa répétition n'est pas un doublon de ligne.
  assert.deepEqual(report(["note", "y"], rows(400, (row) => [`t${row}`, String(row % 2)])).duplicates, { rows: 0, maxRepeat: 0 });
  const inspection = inspectCsvTable({ ok: true, table: [header, ...body] }, "linear_regression");
  assert.equal(inspection.ok, false);
  assert.ok(!inspection.ok && inspection.reason.kind === "too-few-numeric-columns");
});

test("colonnes constantes et lignes en double sur les colonnes d'entraînement", () => {
  const header = ["note", "a", "k", "y"];
  // « note » diffère, mais n'entre pas dans l'entraînement : les lignes 0, 100, 200 et 300 sont identiques pour le modèle.
  const body = rows(400, (row) => [`n${row}`, String(row % 100), "5", String(row % 100 < 50 ? 0 : 1)]);
  const result = report(header, body);
  assert.deepEqual(result.constant, ["k"]);
  assert.deepEqual(result.duplicates, { rows: 400, maxRepeat: 4 });
  // « 1.0 » et « 1 » sont la même valeur pour le modèle ; une cellule avec virgule ne fusionne pas deux colonnes.
  const twins = report(["a", "b", "y"], [["1", "12", "0"], ["1.0", "12", "0"], ["11", "2", "0"], ["3", "4", "1"]]);
  assert.deepEqual(twins.duplicates, { rows: 2, maxRepeat: 2 });
});

test("variable qui recopie la cible : identique, inverse ou corrélée au seuil provisoire", () => {
  const body = rows(400, (row) => {
    const y = row % 2;
    return [String(row), String(y), String(1 - y), String(y * 10 + (row % 3) * 0.01), String((row * 37) % 101), String(y)];
  });
  const result = report(["id", "same", "flip", "near", "noise", "y"], body);
  assert.deepEqual(
    result.targetCopies.map(({ column, kind }) => [column, kind]),
    [["same", "identical"], ["flip", "inverse"], ["near", "correlated"]],
  );
  assert.ok(Math.abs(result.targetCopies[2].correlation) >= TARGET_COPY_MIN_ABS_CORRELATION);

  // Juste sous le seuil : bruit croissant jusqu'à passer sous 0,98.
  const linear = (noise: number) => report(["x", "y"], rows(1000, (row) => [String(row + ((row * 7919) % 101) * noise), String(row)]));
  assert.equal(linear(0).targetCopies[0].kind, "identical");
  let noise = 1;
  while (linear(noise).targetCopies.length > 0) noise *= 1.5;
  const below = linear(noise);
  assert.equal(below.targetCopies.length, 0);
  assert.equal(hasQualitySignal(below), false);
});

test("déséquilibre de classes : signalé sous le seuil provisoire, cible 0/1 uniquement", () => {
  const threshold = Math.round(1000 * MIN_MINORITY_CLASS_SHARE);
  const at = report(HEADER, rows(1000, (row) => [...clean(row).slice(0, 3), row < threshold ? "1" : "0"]));
  assert.equal(at.classBalance?.imbalanced, false);
  const under = report(HEADER, rows(1000, (row) => [...clean(row).slice(0, 3), row < threshold - 1 ? "1" : "0"]));
  assert.deepEqual(under.classBalance, { zeros: 1000 - threshold + 1, ones: threshold - 1, minorityShare: (threshold - 1) / 1000, imbalanced: true });
  assert.equal(report(HEADER, rows(400, (row) => [...clean(row).slice(0, 3), String(row % 7)])).classBalance, null);
});

test("aucun jeu d'exemple publié ne déclenche de fuite, de changement de cible ni de colonne écartée", () => {
  const root = join(process.cwd(), "public/examples");
  for (const folder of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    for (const file of readdirSync(join(root, folder.name)).filter((name) => name.endsWith(".csv"))) {
      const path = join(root, folder.name, file);
      const read = readCsvTable(readFileSync(path, "utf8"));
      assert.ok(read.ok, path);
      const result = qualityReport(read.table);
      assert.ok(result, path);
      assert.deepEqual(result.targetCopies, [], path);
      assert.equal(result.targetShift, null, path);
      assert.deepEqual(result.excluded, [], path);
    }
  }
});

test("ROB-01 / ROB-02 : espaces et nombres préfixés ne sont plus lus comme des nombres, comme dans l'enclave", () => {
  // Signe, notation scientifique et espaces autour d'un nombre restent des nombres (même valeur qu'avant).
  const special: Record<number, string> = { 1: " ", 2: "\t", 3: " 5 ", 4: "0x10", 5: " 0b101 ", 6: "0o7", 7: "0X1F", 8: "1e3", 9: "+5", 10: "2.5E-4", 11: "" };
  const body = rows(400, (row) => [String(row), special[row] ?? String((row * 37) % 101), String(row % 2)]);
  const result = report(["id", "a", "y"], body);
  // Cellules vides ou d'espaces : manquantes ; préfixes 0x / 0b / 0o : non numériques. La colonne est écartée.
  assert.deepEqual(result.excluded, [{ column: "a", missing: 3, invalid: 4 }]);
  const enclave = trainingColumns(Buffer.from([["id", "a", "y"], ...body].map((line) => line.join(",")).join("\n")), undefined, Infinity);
  assert.deepEqual(enclave.featureIdx.map((column) => enclave.header[column]), ["id"]);
  // Une seule cellule d'espaces suffit à écarter la colonne, et c'est signalé.
  const blank = report(["a", "b", "y"], rows(400, (row) => [row === 0 ? " " : String(row), String((row * 37) % 101), String(row % 2)]));
  assert.deepEqual(blank.excluded, [{ column: "a", missing: 1, invalid: 0 }]);
  assert.ok(hasQualitySignal(blank));
  // Une colonne d'identifiants hexadécimaux est du texte, ignorée par l'entraînement.
  const ids = report(["ref", "a", "y"], rows(400, (row) => [`0x${(row * 2_654_435_761 >>> 8).toString(16)}`, String(row), String(row % 2)]));
  assert.deepEqual(ids.textColumns, ["ref"]);
});
