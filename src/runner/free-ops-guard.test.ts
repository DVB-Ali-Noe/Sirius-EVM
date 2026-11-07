import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough, Readable } from "node:stream";
import {
  API_INFO_RATE_LIMITED,
  API_RATE_LIMITED,
  ApiOpsGuard,
  apiOpsPolicy,
  DEFAULT_FREE_OPS_POLICY,
  FREE_OPS_RATE_LIMITED,
  FREE_OPS_SUSPENDED,
  FreeOpsGuard,
  freeOpsPolicyFromEnv,
  type FreeOpsPolicy,
} from "./free-ops-guard";

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function policy(change: Partial<FreeOpsPolicy> = {}): FreeOpsPolicy {
  return { ...DEFAULT_FREE_OPS_POLICY, ...change };
}

test("ROB-08 : le seau à jetons borne la rafale puis le débit soutenu, par opération", () => {
  const time = clock();
  const guard = new FreeOpsGuard(policy({ perMinute: 60, burst: 3 }), time.now);
  for (let i = 0; i < 3; i++) {
    const decision = guard.admit("dataset-ingress-key");
    assert.equal(decision.admitted, true);
    if (decision.admitted) decision.release();
  }
  const refused = guard.admit("dataset-ingress-key");
  assert.deepEqual(refused, { admitted: false, status: 429, error: FREE_OPS_RATE_LIMITED, retryAfterSeconds: 1 });
  // Chaque opération gratuite garde son propre seau (nom synthétique : une seule existe aujourd'hui).
  const other = guard.admit("other-free-op");
  assert.equal(other.admitted, true);
  if (other.admitted) other.release();
  // 60 par minute : un jeton revient chaque seconde.
  time.advance(1_000);
  const refilled = guard.admit("dataset-ingress-key");
  assert.equal(refilled.admitted, true);
  if (refilled.admitted) refilled.release();
  assert.equal(guard.admit("dataset-ingress-key").admitted, false);
  // Après un long calme, le seau ne dépasse jamais sa capacité.
  time.advance(3_600_000);
  let admitted = 0;
  for (let i = 0; i < 10; i++) {
    const decision = guard.admit("dataset-ingress-key");
    if (decision.admitted) { admitted += 1; decision.release(); }
  }
  assert.equal(admitted, 3);
});

test("ROB-08 : une concurrence propre aux opérations gratuites, rendue une seule fois", () => {
  const time = clock();
  const guard = new FreeOpsGuard(policy({ concurrency: 2 }), time.now);
  const first = guard.admit("other-free-op");
  const second = guard.admit("dataset-ingress-key");
  assert.ok(first.admitted && second.admitted);
  const third = guard.admit("other-free-op");
  assert.equal(third.admitted, false);
  if (!third.admitted) assert.equal(third.status, 503);
  first.release();
  first.release();
  assert.equal(guard.state().active, 1, "une double libération ne crée pas de place");
  const fourth = guard.admit("other-free-op");
  assert.equal(fourth.admitted, true);
});

test("ROB-08 : le coupe-circuit s’ouvre quand le traitement dépasse sa part de la fenêtre, puis se referme", () => {
  const time = clock();
  const guard = new FreeOpsGuard(policy({ burst: 100, perMinute: 600, breakerWindowMs: 10_000, breakerBusyMs: 3_000, breakerCooldownMs: 30_000 }), time.now);
  // Disque lent : chaque appel bloque 800 ms ; le quatrième dépasse 3 s cumulées.
  for (let i = 0; i < 4; i++) {
    const decision = guard.admit("dataset-ingress-key");
    assert.equal(decision.admitted, true, `appel ${i}`);
    time.advance(800);
    if (decision.admitted) decision.release();
  }
  assert.equal(guard.state().open, true);
  const suspended = guard.admit("other-free-op");
  assert.deepEqual(suspended, { admitted: false, status: 503, error: FREE_OPS_SUSPENDED, retryAfterSeconds: 30 });
  time.advance(29_000);
  assert.equal(guard.admit("dataset-ingress-key").admitted, false);
  time.advance(1_000);
  const reopened = guard.admit("dataset-ingress-key");
  assert.equal(reopened.admitted, true);
});

test("ROB-08 : des appels rapides restent sous le seuil, la fenêtre glisse", () => {
  const time = clock();
  const guard = new FreeOpsGuard(policy({ burst: 100, perMinute: 600 }), time.now);
  for (let i = 0; i < 60; i++) {
    const decision = guard.admit("other-free-op");
    assert.equal(decision.admitted, true);
    time.advance(100);
    if (decision.admitted) decision.release();
    time.advance(900);
  }
  assert.equal(guard.state().open, false);
});

test("ROB-08 : la politique vient de l’environnement, bornée, avec des valeurs prudentes par défaut", () => {
  assert.deepEqual(freeOpsPolicyFromEnv({}), DEFAULT_FREE_OPS_POLICY);
  assert.deepEqual(freeOpsPolicyFromEnv({ RUNNER_FREE_OPS_PER_MINUTE: "120", RUNNER_FREE_OPS_BURST: "20" }),
    { ...DEFAULT_FREE_OPS_POLICY, perMinute: 120, burst: 20 });
  for (const [name, value] of [
    ["RUNNER_FREE_OPS_PER_MINUTE", "0"], ["RUNNER_FREE_OPS_PER_MINUTE", "601"], ["RUNNER_FREE_OPS_BURST", "1.5"],
    ["RUNNER_FREE_OPS_CONCURRENCY", "9"], ["RUNNER_FREE_OPS_BREAKER_BUSY_MS", "10000"], ["RUNNER_FREE_OPS_BREAKER_COOLDOWN_MS", "abc"],
  ] as const) {
    assert.throws(() => freeOpsPolicyFromEnv({ [name]: value }), new RegExp(name), `${name}=${value}`);
  }
});

test("API : 120 api-predict + api-info par minute et par prêt, dont 60 api-info, fenêtre glissante", () => {
  const time = clock();
  const guard = new ApiOpsGuard(apiOpsPolicy(8), time.now);
  const admit = (op: string, loanId = "loan-1") => {
    const decision = guard.admit(op, loanId);
    if (decision.admitted) decision.release();
    return decision;
  };
  for (let i = 0; i < 60; i++) assert.equal(admit("api-info").admitted, true);
  const info = admit("api-info");
  assert.equal(info.admitted, false);
  if (!info.admitted) assert.deepEqual([info.status, info.code, info.error], [429, "rate_limited", API_INFO_RATE_LIMITED]);
  for (let i = 0; i < 60; i++) assert.equal(admit("api-predict").admitted, true, "les descriptions refusées ne comptent pas");
  const predict = admit("api-predict");
  assert.equal(predict.admitted, false);
  if (!predict.admitted) {
    assert.deepEqual([predict.status, predict.code, predict.error], [429, "rate_limited", API_RATE_LIMITED]);
    assert.equal(predict.retryAfterSeconds, 60);
  }
  assert.equal(admit("api-predict", "loan-2").admitted, true, "un autre prêt garde sa propre fenêtre");
  assert.equal(admit("register-api-key").admitted, true, "clés : hors fenêtre de débit");
  time.advance(60_000);
  assert.equal(admit("api-info").admitted, true, "la fenêtre glisse");
});

test("API : concurrence propre limitée à la moitié des places payantes, rendue une seule fois", () => {
  assert.equal(apiOpsPolicy(8).concurrency, 4);
  assert.equal(apiOpsPolicy(1).concurrency, 1);
  const guard = new ApiOpsGuard(apiOpsPolicy(8), clock().now);
  const held = Array.from({ length: 4 }, (_, i) => guard.admit(i % 2 ? "api-info" : "revoke-api-key", `loan-${i}`));
  assert.ok(held.every((decision) => decision.admitted));
  const refused = guard.admit("api-predict", "loan-9");
  assert.equal(refused.admitted, false);
  if (!refused.admitted) assert.deepEqual([refused.status, refused.error], [503, "Runner saturé"]);
  const first = held[0];
  if (first.admitted) { first.release(); first.release(); }
  assert.equal(guard.state().active, 3, "une double libération ne crée pas de place");
  assert.equal(guard.admit("api-predict", "loan-9").admitted, true);
});

// --- Intégration dans le serveur runner : seau réduit à 3 pour le test. ---

type Server = typeof import("./server");
type Capability = typeof import("@/lib/runner/capability");
let server: Server;
let capability: Capability;

before(async () => {
  Object.assign(process.env, {
    TEE_MODE: "stub",
    SIRIUS_MASTER_KEY: Buffer.alloc(32, 21).toString("base64"),
    RUNNER_TRANSPORT_SECRET: Buffer.alloc(32, 22).toString("base64"),
    SIRIUS_APP_ORIGIN: "http://localhost:3000",
    RUNNER_FREE_OPS_BURST: "3",
    RUNNER_FREE_OPS_PER_MINUTE: "1",
  });
  server = await import("./server");
  capability = await import("@/lib/runner/capability");
});

async function call(op: string, scope: Record<string, string>, body = "{}"): Promise<{ status: number; body: { error?: string }; headers: Record<string, string> }> {
  const req = Readable.from([body]) as IncomingMessage;
  Object.assign(req, {
    method: "POST",
    url: `/${op}`,
    headers: {
      "x-sirius-runner-capability": capability.issueRunnerCapability(op as never, scope as never),
      "content-length": String(Buffer.byteLength(body)),
    },
  });
  let status = 0;
  let payload = "";
  let headers: Record<string, string> = {};
  const res = {
    writeHead(code: number, values: Record<string, string>) { status = code; headers = values; return this; },
    end(chunk: string) { payload = chunk; return this; },
  } as unknown as ServerResponse;
  await server.handleRunnerRequest(req, res);
  return { status, body: JSON.parse(payload) as { error?: string }, headers };
}

test("ROB-08 : le runner refuse en 429 une rafale d’opérations gratuites sans gêner le parcours payant", async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) statuses.push((await call("dataset-ingress-key", {})).status);
  assert.deepEqual(statuses, [200, 200, 200]);
  const limited = await call("dataset-ingress-key", {});
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, FREE_OPS_RATE_LIMITED);
  assert.ok(Number(limited.headers["retry-after"]) >= 1);

  // Une opération payante n'est pas touchée par la limite : elle va jusqu'à sa propre validation.
  const training = await call("run-training", { datasetId: "dataset-1", jobId: "job-1" }, JSON.stringify({
    datasetId: "dataset-1", jobId: "job-1", cid: "bafy-dataset", wrappedKey: "wrapped-key", merkleRoot: "a".repeat(64),
    priceUsdcAtomic: "1000000000000000000", challengeDays: 7, maxRentalDays: 30, modelId: "other", modelVersion: "1.0.0", datasetReceipt: "x",
  }));
  assert.equal(training.status, 400);
  assert.deepEqual(training.body, { error: "Modèle ou version non autorisé" });
});

test("ROB-09 : l’admission HTTP suit maxActive / 2 sans jamais dépasser le plafond configuré", () => {
  assert.equal(server.admittedRequestLimit(8, undefined), 8);
  assert.equal(server.admittedRequestLimit(8, 16), 8);
  assert.equal(server.admittedRequestLimit(8, 1000), 8);
  assert.equal(server.admittedRequestLimit(8, 8), 4);
  assert.equal(server.admittedRequestLimit(8, 3), 1);
  assert.equal(server.admittedRequestLimit(8, 1), 1);
});

test("ROB-10 : le runner garde une connexion inactive plus longtemps que le client (4 s)", () => {
  assert.ok(server.RUNNER_KEEP_ALIVE_TIMEOUT_MS >= 10_000);
  assert.ok(server.RUNNER_HEADERS_TIMEOUT_MS > server.RUNNER_KEEP_ALIVE_TIMEOUT_MS);
  assert.ok(server.RUNNER_HEADERS_TIMEOUT_MS < server.RUNNER_REQUEST_TIMEOUT_MS);
});

test("API : le runner répond 429 rate_limited au-delà de la limite par prêt", async () => {
  const loanId = "loan-rate";
  const body = JSON.stringify({ loanId });
  for (let i = 0; i < 60; i++) assert.notEqual((await call("api-info", { loanId }, body)).status, 429);
  const info = await call("api-info", { loanId }, body);
  assert.equal(info.status, 429);
  assert.deepEqual(info.body, { error: API_INFO_RATE_LIMITED, code: "rate_limited" });
  assert.ok(Number(info.headers["retry-after"]) >= 1);
  for (let i = 0; i < 60; i++) assert.notEqual((await call("api-predict", { loanId }, body)).status, 429);
  const predict = await call("api-predict", { loanId }, body);
  assert.equal(predict.status, 429);
  assert.deepEqual(predict.body, { error: API_RATE_LIMITED, code: "rate_limited" });
  assert.notEqual((await call("api-predict", { loanId: "loan-other" }, JSON.stringify({ loanId: "loan-other" }))).status, 429);
});

test("API : sous charge API, les opérations payantes gardent leurs places", async () => {
  // Quatre requêtes API bloquées sur leur corps occupent toute la part API (8 places payantes / 2).
  const held = Array.from({ length: 4 }, (_, i) => {
    const loanId = `loan-held-${i}`;
    const raw = JSON.stringify({ loanId });
    const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
    Object.assign(req, { method: "POST", url: "/api-info", headers: {
      "x-sirius-runner-capability": capability.issueRunnerCapability("api-info", { loanId }),
      "content-length": String(Buffer.byteLength(raw)),
    } });
    let status = 0;
    const res = {
      writeHead(code: number) { status = code; return this; },
      end() { return this; },
    } as unknown as ServerResponse;
    const done = server.handleRunnerRequest(req, res).then(() => status);
    return { finish: () => { req.end(raw); return done; } };
  });
  // L'admission est synchrone, avant la lecture du corps : les quatre places sont déjà prises.
  const saturated = await call("api-info", { loanId: "loan-held-x" }, JSON.stringify({ loanId: "loan-held-x" }));
  assert.equal(saturated.status, 503);
  assert.equal(saturated.body.error, "Runner saturé");
  // Une opération payante est admise et va jusqu'à sa propre validation.
  const training = await call("run-training", { datasetId: "dataset-2", jobId: "job-2" }, JSON.stringify({
    datasetId: "dataset-2", jobId: "job-2", cid: "bafy-dataset", wrappedKey: "wrapped-key", merkleRoot: "a".repeat(64),
    priceUsdcAtomic: "1000000000000000000", challengeDays: 7, maxRentalDays: 30, modelId: "other", modelVersion: "1.0.0", datasetReceipt: "x",
  }));
  assert.equal(training.status, 400);
  assert.deepEqual(training.body, { error: "Modèle ou version non autorisé" });
  for (const request of held) assert.notEqual(await request.finish(), 503);
  assert.notEqual((await call("api-info", { loanId: "loan-held-x" }, JSON.stringify({ loanId: "loan-held-x" }))).status, 503, "places API rendues");
});
