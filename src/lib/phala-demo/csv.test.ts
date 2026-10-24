import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { csvWithTargetLast, demoQualityReport, tableWithTargetLast } from "./csv";
import { DEMO_EXAMPLES } from "./examples";
import { trainSelectedModel } from "../tee/model-registry";
import { gateModel } from "../tee/output-gate";
import { DatasetValidationError, trainingColumns } from "../tee/train";
import { parseCsv } from "../sirius/metrics";
import { qualityReport } from "../datasets/quality";

test("les deux exemples passent les vrais profils et la porte de sortie du runner", () => {
  for (const sample of DEMO_EXAMPLES) {
    const bytes = csvWithTargetLast(readFileSync(join(process.cwd(), "public", sample.path), "utf8"), sample.target);
    const result = gateModel(trainSelectedModel({ modelId: sample.modelId, modelVersion: "1.0.0" }, Buffer.from(bytes))).model;
    assert.equal(result.target, sample.target);
    assert.equal(result.algo, sample.modelId);
    assert.ok(result.metrics.n >= 100);
  }
});

test("la cible choisie reste la cible ; aucune colonne texte ne lui est substituée", () => {
  assert.equal(new TextDecoder().decode(csvWithTargetLast('target,note,x\n2,"a,b",1', "target")), 'note,x,target\n"a,b",1,2');
  for (const input of ["x,target\n1,yes", "x,target\n1,", "x,target\n1,Infinity"]) assert.throws(() => csvWithTargetLast(input, "target"), /numérique/);
  assert.throws(() => csvWithTargetLast("x,x\n1,2", "x"), /En-têtes/);
  // Le parseur partagé refuse la ligne trop longue, avec son numéro (même refus que l'enclave).
  assert.throws(() => csvWithTargetLast("x,target\n1,2,3", "target"), /ligne 2 : 3 cellule\(s\) pour 2 colonne\(s\)/);
});

test("la cible accepte les mêmes nombres que l'enclave : 1e12 passe, au-delà refusé avant tout envoi", () => {
  const file = (value: string) => `x,target\n${Array.from({ length: 150 }, (_, row) => `${row},${row === 3 ? value : row}`).join("\n")}`;
  const enclave = (bytes: Uint8Array) => trainingColumns(Buffer.from(bytes), undefined, Infinity);
  assert.equal(enclave(csvWithTargetLast(file("1e12"), "target")).header.at(-1), "target");
  assert.throws(() => csvWithTargetLast(file("1000000000001"), "target"), /numérique/);
  // Sans le contrôle du navigateur, l'enclave aurait écarté la colonne, et refusé faute de deux colonnes numériques.
  assert.throws(() => trainingColumns(Buffer.from(file("1000000000001")), undefined, Infinity), DatasetValidationError);
});

test("le rapport de /phala porte sur la cible choisie, comme le fichier envoyé à l'enclave", () => {
  const text = `y,copy,noise,last\n${Array.from({ length: 200 }, (_, row) => `${row % 2},${row % 2},${(row * 37) % 101},${(row * 53) % 97}`).join("\n")}`;
  const table = parseCsv(text);
  assert.deepEqual(tableWithTargetLast(table, "y"), parseCsv(new TextDecoder().decode(csvWithTargetLast(text, "y"))));
  const result = demoQualityReport(table, "y");
  assert.deepEqual(result?.report.targetCopies.map(({ column, kind }) => [column, kind]), [["copy", "identical"]]);
  assert.equal(result?.invalidTarget, 0);
  // Avec la dernière colonne pour cible, comme le ferait /datasets/new, la fuite passerait inaperçue.
  assert.deepEqual(qualityReport(table)?.targetCopies, []);
  // Ligne courte : cellule cible absente, lue vide, sans exception.
  assert.deepEqual(tableWithTargetLast([["y", "x"], ["1"]], "y"), [["x", "y"], ["", "1"]]);
});

test("cible non numérique sur /phala : annoncée une seule fois, ni « cible qui change » ni colonne écartée", () => {
  const rows = Array.from({ length: 200 }, (_, row) => `${(row * 37) % 101},${(row * 53) % 97},${row === 4 ? "" : row === 9 ? "n/a" : row % 7},note ${row}`);
  const table = parseCsv(`a,b,score,commentaire\n${rows.join("\n")}`);
  const result = demoQualityReport(table, "score");
  assert.equal(result?.invalidTarget, 2);
  assert.equal(result?.report.targetShift, null);
  assert.deepEqual(result?.report.excluded, []);
  assert.deepEqual(result?.report.textColumns, ["commentaire"]);
  // Une autre colonne mal remplie reste listée : seule la cible est retirée.
  const other = demoQualityReport(parseCsv(`a,b,y\n${Array.from({ length: 200 }, (_, row) => `${row === 2 ? "" : row},${row % 5},${row % 2}`).join("\n")}`), "y");
  assert.deepEqual(other?.report.excluded, [{ column: "a", missing: 1, invalid: 0 }]);
  assert.equal(demoQualityReport(table, "absente"), null);
});

test("cible choisie sur /phala : cellules d'espaces et 0x refusées avant envoi, comme l'enclave les refuserait", () => {
  const text = `score,a,b\n${Array.from({ length: 200 }, (_, row) => `${row === 3 ? "  " : row === 8 ? "0x1" : row % 7},${(row * 37) % 101},${(row * 53) % 97}`).join("\n")}`;
  const result = demoQualityReport(parseCsv(text), "score");
  assert.equal(result?.invalidTarget, 2);
  assert.throws(() => csvWithTargetLast(text, "score"), /numérique/);
  // Espaces autour d'un nombre : toujours un nombre, même valeur.
  const padded = text.replace("\n  ,", "\n 3 ,").replace("\n0x1,", "\n1,");
  assert.equal(demoQualityReport(parseCsv(padded), "score")?.invalidTarget, 0);
  assert.doesNotThrow(() => csvWithTargetLast(padded, "score"));
});

test("les exemples de /phala, avec leur cible, ne déclenchent ni fuite ni cible non numérique", () => {
  for (const sample of DEMO_EXAMPLES) {
    const table = parseCsv(readFileSync(join(process.cwd(), "public", sample.path), "utf8"));
    const result = demoQualityReport(table, sample.target);
    assert.deepEqual(result?.report.targetCopies, [], sample.path);
    assert.equal(result?.invalidTarget, 0, sample.path);
  }
});
