import * as viem from "viem";
import { keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";
import { AppError, errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import * as models from "@/lib/models/registry";
import * as contract from "@/lib/tee/contract";
import type * as Prediction from "./prediction";
import type * as TrainPredictRoute from "../../app/api/train/[id]/predict/route";
import type * as LoanPredictRoute from "../../app/api/loans/[id]/predict/route";

const OWNER = `0x${"11".repeat(20)}`;
const OTHER = `0x${"22".repeat(20)}`;
const CHAIN_ID = 46630;
const FINGERPRINT = `sm1${"ab".repeat(32)}`;
const SETTLE_TX = `0x${"55".repeat(32)}`;
const features = { income: 45000, debt: 12 };
const runnerKey = privateKeyToAccount(`0x${"42".repeat(32)}`);
const forger = privateKeyToAccount(`0x${"43".repeat(32)}`);

type Kind = "job" | "loan";
type Row = Record<string, unknown>;

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const exports = {};
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { exports, Buffer, console, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Dépendance inattendue : ${name}`);
    return dependencies[name];
  } });
  return exports as T;
}

interface SignOptions {
  ref: { kind: Kind; id: string };
  modelId: string;
  modelVersion: string;
  outputKind: string;
  output: string;
  subject?: string;
  sessionRevision?: number;
  signWith?: typeof runnerKey;
}

/** Réponse runner signée comme le fait l'enclave (EIP-712 `Prediction`, domaine v2). */
async function signPrediction(options: SignOptions) {
  const modelRef = `${options.ref.kind}:${options.ref.id}`;
  const domain = { name: contract.PREDICTION_DOMAIN_NAME, version: contract.PREDICTION_DOMAIN_VERSION, chainId: CHAIN_ID };
  const signedMessage = {
    modelRef, modelId: options.modelId, modelVersion: options.modelVersion, subject: options.subject ?? OWNER,
    featuresHash: keccak256(stringToHex(JSON.stringify(features))), outputKind: options.outputKind, output: options.output,
    counter: 2, sessionRevision: options.sessionRevision ?? 0,
  };
  const signature = await (options.signWith ?? runnerKey).signTypedData({
    domain, types: contract.PREDICTION_EIP712_TYPES, primaryType: "Prediction",
    message: { ...signedMessage, subject: signedMessage.subject as `0x${string}`, featuresHash: signedMessage.featuresHash,
      counter: BigInt(signedMessage.counter), sessionRevision: BigInt(signedMessage.sessionRevision) },
  } as never);
  return { modelRef, modelId: options.modelId, modelVersion: options.modelVersion, outputKind: options.outputKind,
    output: options.output, counter: 2, signer: runnerKey.address, signature, domain, signedMessage };
}

interface HarnessOptions {
  address?: string;
  row?: Row;
  demo?: boolean;
  phase?: string;
  revision?: number;
  runnerKind?: string;
  respond?: () => Promise<unknown>;
}

const JOB: Row = { id: "job-1", owner: OWNER, status: "DONE", servedModelId: "job-1", modelId: "gradient_boosted_trees",
  modelVersion: "1.1.0", modelCid: FINGERPRINT };
const LOAN: Row = { id: "loan-1", borrower: OWNER, status: "SETTLED", finalityReview: null, runnerReceipt: "loan-receipt",
  settleTxHash: SETTLE_TX, finalityTier: "FAST", modelId: "linear_regression", modelVersion: "1.0.0", modelCid: FINGERPRINT };

function harness(kind: Kind, options: HarnessOptions = {}) {
  const calls: string[] = [];
  const runnerCalls: unknown[][] = [];
  const row = { ...(kind === "job" ? JOB : LOAN), ...options.row };
  const demo = options.demo ?? false;
  const prediction = load<typeof Prediction>("src/lib/sirius/prediction.ts", {
    "server-only": {}, viem, "@/lib/errors": { AppError }, "@/lib/tee/contract": contract,
    "@/lib/tee/evm-binding": { evmEscrowBinding: () => ({ chainId: CHAIN_ID, escrow: OTHER }) },
    "@/lib/phala-demo/controller-client": { requestDemoController: async () => {
      calls.push("session");
      return { phase: options.phase ?? "open", available: true, sessionRevision: options.revision ?? 3 };
    } },
    "@/lib/sirius/self-training-access": { phalaDemoInstance: () => demo },
  });
  const session = { address: options.address ?? OWNER };
  const common = {
    "next/server": { NextResponse },
    "@/lib/db": { prisma: { [kind === "job" ? "trainingJob" : "loan"]: { findUnique: async () => { calls.push("lookup"); return row; } } } },
    "@/lib/auth/require-auth": { requireAuth: () => session, assertAuthenticGrant: async () => { calls.push("grant"); },
      assertOwner: (current: typeof session, owner: string) => { calls.push("owner"); if (current.address !== owner) throw new AppError("Interdit", 403); } },
    "@/lib/errors": { AppError, errorResponse },
    "@/lib/http/body": { readJson },
    "@/lib/http/rate-limit": { FixedWindowRateLimiter: class {}, enforceRateLimit: () => { calls.push("rate"); } },
    "@/lib/sirius/self-training-access": { phalaDemoInstance: () => demo, assertSelfTrainingAccess: () => { calls.push("access"); } },
    "@/lib/sirius/access": { requireAcceptedKyb: async () => { calls.push("kyb"); } },
    "@/lib/sirius/prediction": prediction,
    "@/lib/models/registry": models,
    "@/lib/runner/provenance": { assertCurrentRunner: async () => { calls.push("provenance"); return { runnerKind: options.runnerKind ?? "PHALA" }; } },
    "@/lib/tee/runner-client": { predictInRunner: async (...args: unknown[]) => {
      calls.push("runner");
      runnerCalls.push(args);
      if (options.respond) return options.respond();
      return signPrediction(kind === "job"
        ? { ref: { kind, id: "job-1" }, modelId: "gradient_boosted_trees", modelVersion: "1.1.0", outputKind: "decision", output: "1", sessionRevision: demo ? 3 : 0 }
        : { ref: { kind, id: "loan-1" }, modelId: "linear_regression", modelVersion: "1.0.0", outputKind: "value", output: "1230", sessionRevision: demo ? 3 : 0 });
    } },
  };
  const route = kind === "job"
    ? load<typeof TrainPredictRoute>("src/app/api/train/[id]/predict/route.ts", common)
    : load<typeof LoanPredictRoute>("src/app/api/loans/[id]/predict/route.ts", {
      ...common, "@/lib/sirius/finality-tier": { effectiveLoanFinalityTier: (tier: string) => tier },
    });
  const id = kind === "job" ? "job-1" : "loan-1";
  const grant = (extra: Row = {}) => ({ payload: { operation: "predict", [kind === "job" ? "jobId" : "loanId"]: id,
    ...(demo ? { demoSessionRevision: options.revision ?? 3 } : {}), ...extra }, signature: "signed" });
  const send = (payload: unknown = { features, authorization: grant() }) => route.POST(
    new Request(`https://test.invalid/api/${kind === "job" ? "train" : "loans"}/${id}/predict`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
    { params: Promise.resolve({ id }) });
  return { calls, runnerCalls, send, grant };
}

test("self-train : prédiction signée du propriétaire, revalidée, sans probabilité ni champ runner en trop", async () => {
  const expected = await signPrediction({ ref: { kind: "job", id: "job-1" }, modelId: "gradient_boosted_trees", modelVersion: "1.1.0",
    outputKind: "decision", output: "1" });
  const { calls, runnerCalls, send } = harness("job", { respond: async () => ({ ...expected, probability: 0.99, score: 1.7 }) });
  const response = await send();
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), expected);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(calls, ["access", "rate", "grant", "lookup", "owner", "kyb", "provenance", "runner"]);
  assert.deepEqual(JSON.parse(JSON.stringify(runnerCalls[0].slice(0, 2))), [{ kind: "job", id: "job-1" }, features]);
  assert.equal(runnerCalls[0][3], undefined, "aucun contexte de prêt pour un self-train");
});

test("self-train : seul le propriétaire d'un job terminé et scellé peut prédire ; l'historique livré est indisponible", async () => {
  for (const [options, status] of [
    [{ address: OTHER }, 403],
    [{ row: { status: "RUNNING" } }, 409],
    [{ row: { servedModelId: null } }, 409],
    [{ row: { modelCid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" } }, 409],
    [{ row: { modelCid: null } }, 409],
    [{ row: { modelVersion: "0.9.0" } }, 409],
  ] as const) {
    const { calls, send } = harness("job", options as HarnessOptions);
    const response = await send();
    assert.equal(response.status, status, JSON.stringify(options));
    assert.ok(!calls.includes("runner"));
  }
});

test("prêt : seul l'emprunteur d'un prêt réglé, hors revue de finalité, avec reçu et règlement, peut prédire", async () => {
  for (const [options, status] of [
    [{ address: OTHER }, 403],
    [{ row: { status: "TRAINING" } }, 409],
    [{ row: { status: "SETTLING" } }, 409],
    [{ row: { status: "CANCELLED" } }, 409],
    [{ row: { finalityReview: "divergence à finalité complète" } }, 409],
    [{ row: { runnerReceipt: null } }, 409],
    [{ row: { settleTxHash: null } }, 409],
    [{ row: { modelCid: "bafyLegacyModel0000000000" } }, 409],
  ] as const) {
    const { calls, send } = harness("loan", options as HarnessOptions);
    const response = await send();
    assert.equal(response.status, status, JSON.stringify(options));
    assert.ok(!calls.includes("runner"), JSON.stringify(options));
  }
});

test("prêt : le runner reçoit le reçu, le hash de règlement et le palier, et rend une valeur arrondie signée", async () => {
  const { calls, runnerCalls, send } = harness("loan");
  const response = await send();
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.modelRef, "loan:loan-1");
  assert.equal(body.outputKind, "value");
  assert.equal(body.output, "1230");
  assert.deepEqual(calls, ["rate", "grant", "lookup", "owner", "kyb", "provenance", "runner"]);
  assert.deepEqual(JSON.parse(JSON.stringify(runnerCalls[0][0])), { kind: "loan", id: "loan-1" });
  assert.deepEqual(JSON.parse(JSON.stringify(runnerCalls[0][3])), { loanReceipt: "loan-receipt", settleTxHash: SETTLE_TX, finalityTier: "FAST" });
});

test("la réponse du runner est revalidée entièrement : forme, profil, sortie, sujet, variables, signature", async () => {
  const base = { ref: { kind: "loan" as const, id: "loan-1" }, modelId: "linear_regression", modelVersion: "1.0.0", outputKind: "value", output: "1230" };
  const decision = { ref: { kind: "job" as const, id: "job-1" }, modelId: "gradient_boosted_trees", modelVersion: "1.1.0", outputKind: "decision", output: "1" };
  const tampered: [Kind, () => Promise<unknown>][] = [
    ["job", async () => signPrediction({ ...decision, output: "0.73" })],
    ["job", async () => signPrediction({ ...decision, outputKind: "value", output: "1" })],
    ["loan", async () => signPrediction({ ...base, output: "1234.5" })],
    ["loan", async () => signPrediction({ ...base, output: "NaN" })],
    ["loan", async () => signPrediction({ ...base, output: "Infinity" })],
    ["loan", async () => signPrediction({ ...base, ref: { kind: "loan", id: "loan-2" } })],
    ["loan", async () => signPrediction({ ...base, ref: { kind: "job", id: "loan-1" } })],
    ["loan", async () => signPrediction({ ...base, modelId: "logistic_regression" })],
    ["loan", async () => signPrediction({ ...base, subject: OTHER })],
    ["loan", async () => signPrediction({ ...base, sessionRevision: 1 })],
    ["loan", async () => ({ ...(await signPrediction({ ...base, signWith: forger })), signer: runnerKey.address })],
    ["loan", async () => { const signed = await signPrediction(base); return { ...signed, signedMessage: { ...signed.signedMessage, output: "1240" } }; }],
    ["loan", async () => { const signed = await signPrediction(base); return { ...signed, signedMessage: { ...signed.signedMessage, featuresHash: keccak256(stringToHex("{}")) } }; }],
    ["loan", async () => { const signed = await signPrediction(base); return { ...signed, domain: { ...signed.domain, version: "1" } }; }],
    ["loan", async () => { const signed = await signPrediction(base); return { ...signed, domain: { ...signed.domain, chainId: 1 } }; }],
    ["loan", async () => { const signed = await signPrediction(base); return { ...signed, counter: 0, signedMessage: { ...signed.signedMessage, counter: 0 } }; }],
    ["job", async () => ({ modelId: "job-1", modelVersion: "1.1.0", decision: 1, counter: 2, probability: 0.9 })],
    ["job", async () => null],
  ];
  for (const [index, [kind, respond]] of tampered.entries()) {
    const response = await harness(kind, { respond }).send();
    assert.equal(response.status, 502, `cas ${index}`);
    assert.doesNotMatch(await response.text(), /probability|0\.73|1234/);
  }
});

test("démo Phala : session ouverte, grant de la révision courante et runner Phala exigés ; hors démo, révision 0", async () => {
  for (const [options, status] of [[{ phase: "closed" }, 403], [{ runnerKind: "DEVELOPMENT" }, 503]] as const) {
    const { calls, send } = harness("job", { demo: true, ...options } as HarnessOptions);
    assert.equal((await send()).status, status, JSON.stringify(options));
    assert.ok(!calls.includes("runner"));
  }
  const stale = harness("job", { demo: true });
  assert.equal((await stale.send({ features, authorization: stale.grant({ demoSessionRevision: 2 }) })).status, 403);
  assert.ok(!stale.calls.includes("runner"));

  const open = harness("loan", { demo: true });
  const response = await open.send();
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).signedMessage.sessionRevision, 3);
  assert.ok(open.calls.includes("session"));

  const outside = harness("job");
  assert.equal((await outside.send({ features, authorization: outside.grant({ demoSessionRevision: 3 }) })).status, 403);
  assert.ok(!outside.calls.includes("session") && !outside.calls.includes("runner"));
});

test("le grant doit viser l'opération predict et exactement ce modèle", async () => {
  for (const kind of ["job", "loan"] as const) {
    for (const extra of [{ operation: "run-training" }, { jobId: "other", loanId: "other" }]) {
      const { calls, send, grant } = harness(kind);
      const response = await send({ features, authorization: grant(extra) });
      assert.equal(response.status, 403, `${kind} ${JSON.stringify(extra)}`);
      assert.ok(!calls.includes("runner"));
    }
  }
});

test("des variables invalides sont rejetées avant le grant, la base et le runner", async () => {
  const tooMany = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`x${index}`, index]));
  const longName = { ["x".repeat(5000)]: 1 };
  for (const kind of ["job", "loan"] as const) {
    for (const invalid of [{ income: "45000" }, {}, [1, 2], tooMany, { income: 1e10 }, { income: -1e10 }, longName, null]) {
      const { calls, send, grant } = harness(kind);
      const response = await send({ features: invalid, authorization: grant() });
      assert.equal(response.status, 400, `${kind} ${JSON.stringify(invalid).slice(0, 40)}`);
      assert.deepEqual(calls.filter((call) => call !== "access"), ["rate"]);
    }
    const { calls, send } = harness(kind);
    assert.equal((await send({ features })).status, 400, "autorisation manquante");
    assert.deepEqual(calls.filter((call) => call !== "access"), ["rate"]);
  }
});

test("aucune route de livraison de modèle ne subsiste", () => {
  for (const path of [
    "src/app/api/models", "src/app/api/train/[id]/key", "src/app/api/loans/[id]/key",
    "src/app/api/loans/[id]/delivery", "src/app/api/phala-demo/results",
  ]) assert.equal(existsSync(path), false, path);
});
