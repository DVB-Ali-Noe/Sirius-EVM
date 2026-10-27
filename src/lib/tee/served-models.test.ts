import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GradientBoostedTreesModel } from "@/lib/models/registry";
import { loadServedModel, saveServedModel } from "./served-models";

const owner = `0x${"12".repeat(20)}`;
const model: GradientBoostedTreesModel = {
  algo: "gradient_boosted_trees", version: "1.1.0", target: "label", features: ["age"], baseScore: 0,
  trees: [{ feature: 0, threshold: 10, left: { value: -0.25 }, right: { value: 0.25 } }],
  metrics: { heldOutAuc: 0.7, heldOutAccuracy: 0.6, heldOutPrecision: 0.6,
    heldOutRecall: 0.5, heldOutF1: 0.55, aucGap: 0.05, n: 10_000 },
};

test("le modèle servi est chiffré au repos, privé, lié au job et non substituable", () => {
  const root = mkdtempSync(join(tmpdir(), "sirius-served-"));
  const previous = { directory: process.env.RUNNER_SERVED_MODELS_DIR, master: process.env.SIRIUS_MASTER_KEY };
  process.env.RUNNER_SERVED_MODELS_DIR = join(root, "private");
  process.env.SIRIUS_MASTER_KEY = Buffer.alloc(32, 19).toString("base64");
  try {
    assert.equal(loadServedModel("job-1"), null);
    saveServedModel("job-1", owner, model);
    assert.equal(statSync(process.env.RUNNER_SERVED_MODELS_DIR).mode & 0o777, 0o700);
    assert.deepEqual(loadServedModel("job-1"), { owner, model });
    const file = join(process.env.RUNNER_SERVED_MODELS_DIR, readdirSync(process.env.RUNNER_SERVED_MODELS_DIR)[0]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(file, "utf8"), /"target"|"metrics"/);
    assert.throws(() => saveServedModel("job-1", owner, model), /EEXIST/);
    assert.equal(loadServedModel("job-2"), null);
    unlinkSync(file);
    symlinkSync(join(root, "untrusted"), file);
    assert.throws(() => loadServedModel("job-1"));
    assert.throws(() => loadServedModel("../outside"), /invalide/);
    symlinkSync(join(root, "private"), join(root, "linked-directory"));
    process.env.RUNNER_SERVED_MODELS_DIR = join(root, "linked-directory");
    assert.throws(() => loadServedModel("job-1"), /Répertoire de modèles privés invalide/);
  } finally {
    if (previous.directory === undefined) delete process.env.RUNNER_SERVED_MODELS_DIR;
    else process.env.RUNNER_SERVED_MODELS_DIR = previous.directory;
    if (previous.master === undefined) delete process.env.SIRIUS_MASTER_KEY;
    else process.env.SIRIUS_MASTER_KEY = previous.master;
    rmSync(root, { recursive: true, force: true });
  }
});
