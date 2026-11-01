import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GradientBoostedTreesModel, LinearRegressionModel } from "@/lib/models/registry";
import { hasSealedLoanModel, loadServedModel, saveServedModel, servedModelFingerprint } from "./served-models";

const owner = `0x${"12".repeat(20)}`;
const model: GradientBoostedTreesModel = {
  algo: "gradient_boosted_trees", version: "1.1.0", target: "label", features: ["age"], baseScore: 0,
  trees: [{ feature: 0, threshold: 10, left: { value: -0.25 }, right: { value: 0.25 } }],
  metrics: { heldOutAuc: 0.7, heldOutAccuracy: 0.6, heldOutPrecision: 0.6,
    heldOutRecall: 0.5, heldOutF1: 0.55, aucGap: 0.05, n: 10_000 },
};
const linear: LinearRegressionModel = {
  algo: "linear_regression", version: "1.0.0", target: "price", features: ["size"], coefficients: [1, 2],
  metrics: { r2: 0.5, rmse: 1, mae: 1, n: 100 },
};

test("le modèle servi est chiffré au repos, privé, lié à sa référence et non substituable", () => {
  const root = mkdtempSync(join(tmpdir(), "sirius-served-"));
  const previous = { directory: process.env.RUNNER_SERVED_MODELS_DIR, master: process.env.SIRIUS_MASTER_KEY };
  process.env.RUNNER_SERVED_MODELS_DIR = join(root, "private");
  process.env.SIRIUS_MASTER_KEY = Buffer.alloc(32, 19).toString("base64");
  try {
    const job = { kind: "job", id: "job-1" } as const;
    assert.equal(loadServedModel(job), null);
    saveServedModel(job, owner, model);
    assert.equal(statSync(process.env.RUNNER_SERVED_MODELS_DIR).mode & 0o777, 0o700);
    assert.deepEqual(loadServedModel(job), { owner, model });
    const file = join(process.env.RUNNER_SERVED_MODELS_DIR, readdirSync(process.env.RUNNER_SERVED_MODELS_DIR)[0]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(file, "utf8"), /"target"|"metrics"/);
    assert.throws(() => saveServedModel(job, owner, model), /EEXIST/);
    assert.equal(loadServedModel({ kind: "job", id: "job-2" }), null);
    // Même identifiant, autre espace : un prêt homonyme n'ouvre jamais le modèle d'un job.
    assert.equal(loadServedModel({ kind: "loan", id: "job-1" }), null);
    saveServedModel({ kind: "loan", id: "job-1" }, owner, linear);
    assert.deepEqual(loadServedModel({ kind: "loan", id: "job-1" }), { owner, model: linear });
    assert.deepEqual(loadServedModel(job), { owner, model });
    unlinkSync(file);
    symlinkSync(join(root, "untrusted"), file);
    assert.throws(() => loadServedModel(job));
    assert.throws(() => loadServedModel({ kind: "job", id: "../outside" }), /invalide/);
    assert.throws(() => loadServedModel({ kind: "other" as never, id: "job-1" }), /invalide/);
    symlinkSync(join(root, "private"), join(root, "linked-directory"));
    process.env.RUNNER_SERVED_MODELS_DIR = join(root, "linked-directory");
    assert.throws(() => loadServedModel(job), /Répertoire de modèles privés invalide/);
  } finally {
    if (previous.directory === undefined) delete process.env.RUNNER_SERVED_MODELS_DIR;
    else process.env.RUNNER_SERVED_MODELS_DIR = previous.directory;
    if (previous.master === undefined) delete process.env.SIRIUS_MASTER_KEY;
    else process.env.SIRIUS_MASTER_KEY = previous.master;
    rmSync(root, { recursive: true, force: true });
  }
});

test("l'empreinte sm1 est canonique, stable et distingue les modèles", () => {
  const fingerprint = servedModelFingerprint(model);
  assert.match(fingerprint, /^sm1[0-9a-f]{64}$/);
  assert.equal(fingerprint.length, 67);
  const reordered = JSON.parse(JSON.stringify({ metrics: model.metrics, trees: model.trees, baseScore: model.baseScore,
    features: model.features, target: model.target, version: model.version, algo: model.algo })) as GradientBoostedTreesModel;
  assert.equal(servedModelFingerprint(reordered), fingerprint);
  assert.notEqual(servedModelFingerprint(linear), fingerprint);
});

test("un prêt n'est réglable que si son modèle est scellé à l'emprunteur sous l'empreinte du reçu", () => {
  const root = mkdtempSync(join(tmpdir(), "sirius-served-loan-"));
  const previous = { directory: process.env.RUNNER_SERVED_MODELS_DIR, master: process.env.SIRIUS_MASTER_KEY };
  process.env.RUNNER_SERVED_MODELS_DIR = join(root, "private");
  process.env.SIRIUS_MASTER_KEY = Buffer.alloc(32, 23).toString("base64");
  try {
    const fingerprint = servedModelFingerprint(linear);
    // Prêt entraîné avant la suppression de la livraison : rien de scellé, ancien CID dans le reçu.
    assert.equal(hasSealedLoanModel("loan-1", owner, "bafyLegacyModel"), false);
    assert.equal(hasSealedLoanModel("loan-1", owner, fingerprint), false);
    saveServedModel({ kind: "loan", id: "loan-1" }, owner, linear);
    assert.equal(hasSealedLoanModel("loan-1", owner.toUpperCase().replace("0X", "0x"), fingerprint), true);
    assert.equal(hasSealedLoanModel("loan-1", `0x${"34".repeat(20)}`, fingerprint), false, "autre emprunteur");
    assert.equal(hasSealedLoanModel("loan-1", owner, servedModelFingerprint(model)), false, "autre empreinte");
    // Un job homonyme ne rend pas un prêt réglable.
    saveServedModel({ kind: "job", id: "loan-2" }, owner, linear);
    assert.equal(hasSealedLoanModel("loan-2", owner, fingerprint), false);
  } finally {
    if (previous.directory === undefined) delete process.env.RUNNER_SERVED_MODELS_DIR;
    else process.env.RUNNER_SERVED_MODELS_DIR = previous.directory;
    if (previous.master === undefined) delete process.env.SIRIUS_MASTER_KEY;
    else process.env.SIRIUS_MASTER_KEY = previous.master;
    rmSync(root, { recursive: true, force: true });
  }
});
