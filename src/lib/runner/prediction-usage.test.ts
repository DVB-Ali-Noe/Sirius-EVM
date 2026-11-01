import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { demoSessions, predictionSessionRevision } from "@/lib/phala-demo/runner-session";
import { reservePrediction } from "./prediction-usage";
import { scopeForRunnerOp } from "@/runner/handler";

const owner = `0x${"ab".repeat(20)}`;
const policy = {
  funding: "credits" as const, creditsUsdMicros: "1000", cashUsdMicros: "0", ceilingUsdMicros: "900",
  maxOperations: 4, maxOperationsPerWallet: 2, maxConcurrent: 1,
};
const job = { kind: "job", id: "model-1" } as const;
const loan = { kind: "loan", id: "model-1" } as const;

function withEnv(values: Record<string, string>, run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "sirius-predict-usage-"));
  const saved = { ...process.env };
  Object.assign(process.env, { RUNNER_PREDICT_USAGE_FILE: join(root, "usage.sqlite"), ...values });
  try {
    run(root);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
}

test("scope runner de predict : job → jobId, prêt → loanId", () => {
  assert.deepEqual(scopeForRunnerOp("predict", { modelRef: job }), { op: "predict", scope: { jobId: "model-1" } });
  assert.deepEqual(scopeForRunnerOp("predict", { modelRef: loan }), { op: "predict", scope: { loanId: "model-1" } });
  assert.throws(() => scopeForRunnerOp("predict", { modelRef: { kind: "dataset", id: "x" } }), /invalide/);
  assert.throws(() => scopeForRunnerOp("predict", { modelRef: { kind: "job", id: "../x" } }), /invalide/);
});

test("hors démonstration : révision 0, quota par (sujet, modelRef) et non par identifiant nu", () => {
  withEnv({ SIRIUS_PHALA_DEMO: "false", RUNNER_PREDICT_DAILY_LIMIT: "2" }, () => {
    assert.equal(predictionSessionRevision(), 0);
    assert.equal(reservePrediction(owner.toUpperCase().replace(/^0X/, "0x"), job, 0), 1);
    assert.equal(reservePrediction(owner, job, 0), 2);
    assert.throws(() => reservePrediction(owner, job, 0), /Quota quotidien/);
    // Un prêt homonyme a son propre quota et son propre compteur.
    assert.equal(reservePrediction(owner, loan, 0), 1);
    assert.equal(reservePrediction(`0x${"cd".repeat(20)}`, job, 0), 1);
    assert.throws(() => reservePrediction(owner, job, 1), /remplacée/);
    assert.throws(() => reservePrediction(owner, { kind: "job", id: "a:b" }, 0), /Scope de prédiction invalide/);
    assert.equal(statSync(process.env.RUNNER_PREDICT_USAGE_FILE!).mode & 0o777, 0o600);
  });
});

test("démonstration : session ouverte obligatoire, révision liée, quota durable après réouverture", () => {
  withEnv({ EVM_NETWORK: "testnet", TEE_MODE: "phala", DSTACK_SIMULATOR_ENDPOINT: "", SIRIUS_PHALA_DEMO: "true",
    RUNNER_PREDICT_DAILY_LIMIT: "2" }, (root) => {
    process.env.RUNNER_DEMO_SESSION_FILE = join(root, "sessions.sqlite");
    assert.throws(predictionSessionRevision, /fermée/);
    const store = demoSessions();
    store.command("open", 0, owner, policy);
    assert.equal(predictionSessionRevision(), 1);
    assert.equal(reservePrediction(owner, job, 1), 1);
    assert.equal(reservePrediction(owner, job, 1), 2);
    assert.throws(() => reservePrediction(owner, job, 1), /Quota quotidien/);
    store.command("close", 1, owner);
    assert.throws(() => reservePrediction(owner, job, 2), /fermée/);
    store.command("open", 2, owner, policy);
    assert.throws(() => reservePrediction(owner, job, 1), /remplacée/);
    assert.throws(() => reservePrediction(owner, job, 3), /Quota quotidien/);
    process.env.RUNNER_PREDICT_DAILY_LIMIT = "101";
    assert.throws(() => reservePrediction(owner, loan, 3), /Quota quotidien de prédiction invalide/);
    store.close();
  });
});
