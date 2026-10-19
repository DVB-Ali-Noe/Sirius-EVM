import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { csvWithTargetLast, tableWithTargetLast } from "./csv";
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
  assert.throws(() => csvWithTargetLast("x,target\n1,2,3", "target"), /colonnes/);
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
  const report = qualityReport(tableWithTargetLast(table, "y"));
  assert.deepEqual(report?.targetCopies.map(({ column, kind }) => [column, kind]), [["copy", "identical"]]);
  assert.equal(report?.targetShift, null);
  // Avec la dernière colonne pour cible, comme le ferait /datasets/new, la fuite passerait inaperçue.
  assert.deepEqual(qualityReport(table)?.targetCopies, []);
  // Ligne courte : cellule cible absente, lue vide, sans exception.
  assert.deepEqual(tableWithTargetLast([["y", "x"], ["1"]], "y"), [["x", "y"], ["", "1"]]);
});

test("les exemples de /phala, avec leur cible, ne déclenchent ni fuite ni cible non numérique", () => {
  for (const sample of DEMO_EXAMPLES) {
    const table = parseCsv(readFileSync(join(process.cwd(), "public", sample.path), "utf8"));
    const report = qualityReport(tableWithTargetLast(table, sample.target));
    assert.deepEqual(report?.targetCopies, [], sample.path);
    assert.equal(report?.targetShift, null, sample.path);
  }
});
