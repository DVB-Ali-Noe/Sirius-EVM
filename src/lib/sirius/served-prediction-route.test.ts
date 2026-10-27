import { keccak256, stringToHex } from "viem";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";
import { AppError, errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import type * as PredictRoute from "../../app/api/models/[cid]/predict/route";
import type * as KeyRoute from "../../app/api/train/[id]/key/route";
import type * as ResultsRoute from "../../app/api/phala-demo/results/[id]/route";
import type * as DownloadRoute from "../../app/api/models/[cid]/route";

const OWNER = `0x${"11".repeat(20)}`;
const OTHER = `0x${"22".repeat(20)}`;
const URL = "https://test.invalid/api/models/job-1/predict";
const params = { params: Promise.resolve({ cid: "job-1" }) };
const features = { income: 45000, debt: 12 };
const signer = `0x${"33".repeat(20)}`;
const signature = `0x${"44".repeat(65)}`;
const authorization = { payload: { operation: "predict", jobId: "job-1", demoSessionRevision: 3 }, signature: "signed" };

function load<T>(file: string, dependencies: Record<string, unknown>, env: Record<string, string | undefined>): T {
  const exports = {};
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { exports, Object, Date, Number, console, process: { env }, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Dépendance inattendue : ${name}`);
    return dependencies[name];
  } });
  return exports as T;
}

function fixture(options: { address?: string; enabled?: boolean; status?: string; servedModelId?: string | null;
  phase?: string; available?: boolean; revision?: number; runnerKind?: string } = {}) {
  const calls: string[] = [];
  const job = { id: "job-1", owner: OWNER, status: options.status ?? "DONE", servedModelId: options.servedModelId === undefined ? "job-1" : options.servedModelId,
    modelId: "gradient_boosted_trees", modelVersion: "1.1.0", modelCid: null, deliveryPublicKey: null, deliveryEnvelope: null };
  const session = { address: options.address ?? OWNER };
  const env = { SIRIUS_PREDICT_ENABLED: options.enabled === false ? "false" : "true", SIRIUS_PHALA_DEMO: "true", EVM_NETWORK: "testnet", TEE_MODE: "phala" };
  const route = load<typeof PredictRoute>("src/app/api/models/[cid]/predict/route.ts", {
    "viem": { keccak256, stringToHex },
    "@/lib/evm/networks": { EVM_CHAIN_IDS: { testnet: 46630 } },
    "next/server": { NextResponse },
    "@/lib/db": { prisma: { trainingJob: { findUnique: async () => { calls.push("lookup"); return job; } } } },
    "@/lib/auth/require-auth": { requireAuth: () => session, assertAuthenticGrant: async () => { calls.push("grant"); },
      assertOwner: (_session: typeof session, owner: string) => { calls.push("owner"); if (_session.address !== owner) throw new AppError("Interdit", 403); } },
    "@/lib/errors": { AppError, errorResponse },
    "@/lib/http/body": { readJson },
    "@/lib/http/rate-limit": { FixedWindowRateLimiter: class {}, enforceRateLimit: () => { calls.push("rate"); } },
    "@/lib/sirius/self-training-access": { phalaDemoInstance: () => env.SIRIUS_PHALA_DEMO === "true" && env.EVM_NETWORK === "testnet" && env.TEE_MODE === "phala" },
    "@/lib/phala-demo/controller-client": { requestDemoController: async () => { calls.push("session"); return { phase: options.phase ?? "open",
      available: options.available ?? true, sessionRevision: options.revision ?? 3 }; } },
    "@/lib/sirius/access": { requireAcceptedKyb: async () => { calls.push("kyb"); } },
    "@/lib/runner/provenance": { assertCurrentRunner: async () => { calls.push("provenance"); return { runnerKind: options.runnerKind ?? "PHALA" }; } },
    "@/lib/tee/runner-client": { predictInRunner: async (id: string, input: unknown) => { calls.push("runner"); assert.equal(id, "job-1");
      assert.equal(JSON.stringify(input), JSON.stringify(features));
      return { modelId: id, modelVersion: "1.1.0", decision: 1, counter: 2, signature, signer,
        domain: { name: "SiriusPrediction", version: "1", chainId: 46630 },
        signedMessage: { modelId: id, modelVersion: "1.1.0", subject: OWNER,
          featuresHash: keccak256(stringToHex(JSON.stringify(features))), decision: 1, counter: 2, sessionRevision: 3 },
        probability: 0.99 }; } },
  }, env);
  return { route, calls, env };
}

function request(payload: unknown = { features, authorization }) {
  return new Request(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}

test("la prédiction est coupée par défaut, avant le corps et le runner", async () => {
  const { route, calls } = fixture({ enabled: false });
  const req = request();
  const result = await route.POST(req, params);
  assert.equal(result.status, 403);
  assert.equal(req.bodyUsed, false);
  assert.deepEqual(calls, []);
});

test("seul le propriétaire d'un job servi terminé peut prédire", async () => {
  for (const options of [{ address: OTHER }, { status: "RUNNING" }, { servedModelId: null }]) {
    const { route, calls } = fixture(options);
    const result = await route.POST(request(), params);
    assert.ok(result.status === 403 || result.status === 409);
    assert.ok(!calls.includes("runner"));
  }
});

test("la session fermée, un grant périmé ou un runner étranger bloquent la prédiction", async () => {
  for (const options of [{ phase: "closed" }, { revision: 4 }, { runnerKind: "DEVELOPMENT" }]) {
    const { route, calls } = fixture(options);
    const result = await route.POST(request(), params);
    assert.equal(result.status, options.runnerKind ? 503 : 403);
    assert.ok(!calls.includes("runner"));
  }
});

test("une prédiction authentifiée renvoie une décision signée sans probabilité", async () => {
  const { route, calls } = fixture();
  const response = await route.POST(request(), params);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { modelId: "job-1", modelVersion: "1.1.0", decision: 1, counter: 2,
    signature, signer, domain: { name: "SiriusPrediction", version: "1", chainId: 46630 },
    signedMessage: { modelId: "job-1", modelVersion: "1.1.0", subject: OWNER,
      featuresHash: keccak256(stringToHex(JSON.stringify(features))), decision: 1, counter: 2, sessionRevision: 3 } });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(calls, ["rate", "grant", "lookup", "owner", "session", "kyb", "provenance", "runner"]);
});

test("les caractéristiques non numériques sont rejetées avant le grant et le runner", async () => {
  const { route, calls } = fixture();
  const response = await route.POST(request({ features: { income: "45000" }, authorization }), params);
  assert.equal(response.status, 400);
  assert.deepEqual(calls, ["rate"]);
});

test("les routes de livraison refusent un job servi même si des champs anciens contiennent une clé", async () => {
  const job = { owner: OWNER, status: "DONE", servedModelId: "job-1", modelCid: "bafyOldModelCiphertext",
    runnerReceipt: "receipt", deliveryEnvelope: { ciphertext: "secret" }, deliveryPublicKey: "public" };
  const auth = { requireAuth: () => ({ address: OWNER }), assertOwner: () => {}, assertAuthenticGrant: async () => {} };
  let delivered = false;
  const key = load<typeof KeyRoute>("src/app/api/train/[id]/key/route.ts", {
    "next/server": { NextResponse }, "@/lib/db": { prisma: { trainingJob: { findUnique: async () => job } } },
    "@/lib/tee/runner-client": { selfTrainModelKeyInRunner: async () => { delivered = true; return { ciphertext: "secret" }; } },
    "@/lib/sirius/self-training-access": { assertSelfTrainingAccess: () => {} },
    "@/lib/auth/require-auth": auth, "@/lib/errors": { errorResponse }, "@/lib/http/body": { readJson },
    "@/lib/http/rate-limit": { FixedWindowRateLimiter: class {}, enforceRateLimit: () => {} },
    "@/lib/runner/provenance": { assertCurrentRunner: async () => {} },
  }, {});
  const keyResponse = await key.POST(new Request("https://test.invalid/api/train/job-1/key", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ authorization, deliveryPublicKey: "public" }) }),
  { params: Promise.resolve({ id: "job-1" }) });
  assert.equal(keyResponse.status, 409);
  assert.equal(delivered, false);

  const results = load<typeof ResultsRoute>("src/app/api/phala-demo/results/[id]/route.ts", {
    "next/server": { NextResponse }, "@/lib/db": { prisma: { trainingJob: { findUnique: async () => job } } },
    "@/lib/auth/require-auth": auth, "@/lib/errors": { errorResponse },
  }, {});
  const resultResponse = await results.GET(new Request("https://test.invalid/api/phala-demo/results/job-1"),
    { params: Promise.resolve({ id: "job-1" }) });
  assert.equal(resultResponse.status, 409);
  assert.equal(JSON.stringify(await resultResponse.json()).includes("secret"), false);
});

test("le téléchargement IPFS ignore les jobs servis même si un CID ancien existe", async () => {
  let fetched = false;
  const download = load<typeof DownloadRoute>("src/app/api/models/[cid]/route.ts", {
    "next/server": { NextResponse }, "@/lib/db": { prisma: {
      loan: { findFirst: async () => null },
      trainingJob: { findFirst: async ({ where }: { where: { servedModelId: string | null } }) => {
        assert.equal(where.servedModelId, null);
        return null;
      } },
    } },
    "@/lib/auth/require-auth": { requireAuth: () => ({ address: OWNER }) },
    "@/lib/errors": { errorResponse }, "@/lib/ipfs/pinata": { fetchFromIpfs: async () => { fetched = true; return ""; } },
    "@/lib/http/rate-limit": { FixedWindowRateLimiter: class {}, enforceRateLimit: () => {} },
  }, {});
  const response = await download.GET(new Request("https://test.invalid/api/models/bafyOldModelCiphertext"),
    { params: Promise.resolve({ cid: "bafyOldModelCiphertext" }) });
  assert.equal(response.status, 404);
  assert.equal(fetched, false);
});
