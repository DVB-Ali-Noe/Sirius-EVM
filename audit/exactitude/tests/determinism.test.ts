/**
 * Q6 : même fichier → même modèle, octet pour octet ; et ce qui change le modèle alors que les données sont « les mêmes ».
 *
 * Lancer : NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/exactitude/tests/determinism.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { modelSelection } from "@/lib/models/registry";
import { trainInWorker } from "@/lib/tee/bounded-training";
import { gateModel } from "@/lib/tee/output-gate";
import { trainGradientBoostedTrees } from "@/lib/tee/train-gbdt";
import { evaluateModelCsv } from "@/lib/train/evaluation-client";

// Le délai de l'entraînement est une horloge murale : sur un poste chargé, 15 s ne suffisent pas toujours (voir EXA-05).
process.env.RUNNER_TRAINING_TIMEOUT_MS = "30000";
// Et l'horloge du délai est ralentie ×10 dans ce processus : seul l'abandon dépend du temps, jamais le modèle.
{
  const now = performance.now.bind(performance);
  const origin = now();
  performance.now = () => origin + (now() - origin) / 10;
}

const sha = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
const reference = resolve(process.cwd(), "public/examples/classification/credit-risk-train.csv");
const taiwan = resolve(process.cwd(), "audit/exactitude/.data/taiwan.csv");
const deliver = (csv: Buffer) => gateModel(trainGradientBoostedTrees(csv)).buffer;

test("même fichier : même buffer livré dans 5 entraînements successifs du même processus", () => {
  const csv = readFileSync(reference);
  const hashes = new Set(Array.from({ length: 5 }, () => sha(deliver(csv))));
  assert.equal(hashes.size, 1);
});

test("même fichier : même buffer dans deux processus Node distincts", () => {
  const files = [reference, ...(existsSync(taiwan) ? [taiwan] : [])];
  for (const file of files) {
    // Horloge du délai ralentie ×10 (poste partagé) : seul l'abandon dépend du temps, pas le modèle.
    const script = `const n=performance.now.bind(performance),o=n();performance.now=()=>o+(n()-o)/10;` +
      `const {createHash}=require("node:crypto");const {readFileSync}=require("node:fs");` +
      `const {gateModel}=require("@/lib/tee/output-gate");const {trainGradientBoostedTrees}=require("@/lib/tee/train-gbdt");` +
      `process.stdout.write(createHash("sha256").update(gateModel(trainGradientBoostedTrees(readFileSync(${JSON.stringify(file)}))).buffer).digest("hex"));`;
    const run = () => spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "-e", script], { encoding: "utf8", timeout: 600_000, env: { ...process.env, RUNNER_TRAINING_TIMEOUT_MS: "30000" } });
    const first = run();
    const second = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.match(first.stdout, /^[0-9a-f]{64}$/);
    assert.equal(first.stdout, second.stdout);
    assert.equal(first.stdout, sha(deliver(readFileSync(file))));
  }
});

test("même fichier : le worker du runner livre le même buffer que l'appel direct", async () => {
  const csv = readFileSync(reference);
  const model = await trainInWorker(modelSelection("gradient_boosted_trees", "1.0.0")!, csv, AbortSignal.timeout(60_000));
  assert.equal(sha(gateModel(model as never).buffer), sha(deliver(csv)));
});

test("fins de ligne CRLF ou LF, retour final présent ou non : même modèle", () => {
  const lf = readFileSync(reference, "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const variants = [lf, `${lf}\n`, lf.replace(/\n/g, "\r\n"), `${lf.replace(/\n/g, "\r\n")}\r\n`];
  const hashes = new Set(variants.map((text) => sha(deliver(Buffer.from(text)))));
  assert.equal(hashes.size, 1);
});

test("mêmes lignes dans un autre ordre : autre split, donc autre modèle et autres métriques", () => {
  const [header, ...rows] = readFileSync(reference, "utf8").trim().split(/\r?\n/);
  const reversed = Buffer.from([header, ...rows.reverse()].join("\n"));
  const original = gateModel(trainGradientBoostedTrees(readFileSync(reference))).model;
  const other = gateModel(trainGradientBoostedTrees(reversed)).model;
  assert.notEqual(sha(deliver(reversed)), sha(deliver(readFileSync(reference))));
  assert.notEqual(other.metrics.heldOutAuc, original.metrics.heldOutAuc);
});

test("CSV UTF-8 avec BOM (export Excel) : le nom de la 1re variable garde le BOM et l'évaluation navigateur échoue", async () => {
  const plain = readFileSync(reference);
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain]);
  const model = gateModel(trainGradientBoostedTrees(withBom)).model;
  assert.equal(model.features[0], "﻿age_years");
  assert.notEqual(sha(deliver(withBom)), sha(deliver(plain)));
  // Le navigateur lit le fichier de test avec File.text(), qui retire le BOM : la colonne ne correspond plus.
  const testText = await new Blob([Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(resolve(process.cwd(), "public/examples/classification/credit-risk-test.csv"))])]).text();
  assert.throws(() => evaluateModelCsv(model, testText), /mêmes features/);
});
