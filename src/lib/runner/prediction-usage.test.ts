import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { demoSessions, assertPredictEnabled } from "@/lib/phala-demo/runner-session";
import { reservePrediction } from "./prediction-usage";
import { handleRunnerOp, scopeForRunnerOp } from "@/runner/handler";

const owner = `0x${"ab".repeat(20)}`;
const policy = {
  funding: "credits" as const, creditsUsdMicros: "1000", cashUsdMicros: "0", ceilingUsdMicros: "900",
  maxOperations: 4, maxOperationsPerWallet: 2, maxConcurrent: 1,
};

test("quota SQLite durable par jour et par propriétaire/modèle, sans remise à zéro après réouverture", async () => {
  const root = mkdtempSync(join(tmpdir(), "sirius-predict-usage-"));
  const saved = { ...process.env };
  Object.assign(process.env, { EVM_NETWORK: "testnet", TEE_MODE: "phala", DSTACK_SIMULATOR_ENDPOINT: "",
    SIRIUS_PHALA_DEMO: "true", SIRIUS_PREDICT_ENABLED: "true", RUNNER_PREDICT_DAILY_LIMIT: "2",
    RUNNER_DEMO_SESSION_FILE: join(root, "sessions.sqlite"), RUNNER_PREDICT_USAGE_FILE: join(root, "usage.sqlite") });
  try {
    assert.deepEqual(scopeForRunnerOp("predict", { modelId: "model-1" }), { op: "predict", scope: { jobId: "model-1" } });
    process.env.SIRIUS_PREDICT_ENABLED = "false";
    await assert.rejects(handleRunnerOp("predict", {}), /désactivée/);
    await assert.rejects(handleRunnerOp("run-training", { served: true }), /désactivée/);
    process.env.SIRIUS_PREDICT_ENABLED = "true";
    assert.throws(assertPredictEnabled, /fermée/);
    const store = demoSessions();
    store.command("open", 0, owner, policy);
    assert.equal(reservePrediction(owner.toUpperCase().replace(/^0X/, "0x"), "model-1", 1), 1);
    assert.equal(reservePrediction(owner, "model-1", 1), 2);
    assert.throws(() => reservePrediction(owner, "model-1", 1), /Quota quotidien/);
    assert.equal(reservePrediction(owner, "model-2", 1), 1);
    assert.equal(statSync(process.env.RUNNER_PREDICT_USAGE_FILE!).mode & 0o777, 0o600);
    store.command("close", 1, owner);
    assert.throws(() => reservePrediction(owner, "model-1", 2), /fermée/);
    store.command("open", 2, owner, policy);
    assert.throws(() => reservePrediction(owner, "model-1", 1), /remplacée/);
    assert.throws(() => reservePrediction(owner, "model-1", 3), /Quota quotidien/);
    process.env.RUNNER_PREDICT_DAILY_LIMIT = "101";
    assert.throws(() => reservePrediction(owner, "model-2", 3), /Quota quotidien de prédiction invalide/);
    store.close();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});
