import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { apiCanonicalString, API_SIGNING_PREFIX } from "../../src/lib/billing/api-pricing";
import { verifyApiSignature } from "../../src/lib/runner/api-signature";
import { canonicalString, parseApiKey, SIRIUS_SIGNING_PREFIX, SiriusApiError, SiriusClient, signRequest } from "./sirius-api";

const vectorPath = fileURLToPath(new URL("../fixtures/api-signing-vector.json", import.meta.url));
const vector = JSON.parse(readFileSync(vectorPath, "utf8")) as {
  keyId: string;
  secret: string;
  token: string;
  loanId: string;
  predict: { method: string; path: string; timestamp: number; nonce: string; body: string; bodySha256Hex: string; canonical: string; signature: string };
  info: { method: string; path: string; timestamp: number; nonce: string; body: string; bodySha256Hex: string; canonical: string; signature: string };
};
const secretBytes = new Uint8Array(Buffer.from(vector.secret, "base64url"));

test("chaîne canonique du SDK identique à celle du serveur (api-pricing.ts), vecteur partagé compris", () => {
  assert.equal(SIRIUS_SIGNING_PREFIX, API_SIGNING_PREFIX);
  for (const request of [vector.predict, vector.info]) {
    const input = { method: request.method, path: request.path, timestamp: request.timestamp, nonce: request.nonce, bodySha256Hex: request.bodySha256Hex };
    assert.equal(canonicalString(input), request.canonical);
    assert.equal(apiCanonicalString(input), request.canonical);
  }
  const odd = { method: "post", path: "/v1/models/abc/predict?x=1&y=2", timestamp: 1, nonce: "n".repeat(16), bodySha256Hex: "ABCDEF" };
  assert.equal(canonicalString(odd), apiCanonicalString(odd));
  assert.throws(() => canonicalString({ ...odd, timestamp: 1.5 }));
});

test("signature du SDK = vecteur partagé, et acceptée par le vérificateur du runner", async () => {
  assert.deepEqual(parseApiKey(vector.token), { keyId: vector.keyId, secret: vector.secret });
  for (const request of [vector.predict, vector.info]) {
    const signed = await signRequest({ secret: vector.secret, ...request });
    assert.equal(signed.bodySha256Hex, request.bodySha256Hex);
    assert.equal(signed.canonical, request.canonical);
    assert.equal(signed.signature, request.signature);
    assert.equal(verifyApiSignature({ secret: secretBytes, ...request, signature: signed.signature }), true);
    // Corps, chemin ou méthode modifiés : la même signature ne vaut plus.
    assert.equal(verifyApiSignature({ secret: secretBytes, ...request, body: `${request.body} `, signature: signed.signature }), false);
    assert.equal(verifyApiSignature({ secret: secretBytes, ...request, path: "/v1/models/other/predict", signature: signed.signature }), false);
  }
  assert.throws(() => parseApiKey(`sk_test_${vector.keyId}.${vector.secret}`));
});

interface Captured { url: string; method: string; headers: Record<string, string>; body: string }

function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>, captured: Captured[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: typeof init?.body === "string" ? init.body : "" });
    const next = responses.shift();
    assert.ok(next, "requête inattendue");
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "Content-Type": "application/json", ...next.headers } });
  }) as typeof fetch;
}

test("predict : requête signée vérifiable, réessai sur 503 Retry-After avec une nouvelle signature", async () => {
  const captured: Captured[] = [];
  const sleeps: number[] = [];
  let clock = vector.predict.timestamp * 1000;
  let nonce = 0;
  const ok = { outputKind: "decision", decision: 1, counter: 3, remaining: { today: 47, credits: 100 }, expiresAt: 1, modelId: "logistic_regression", modelVersion: "1.0.0", signature: "0x", signer: "0x", domain: {}, signedMessage: {} };
  const client = new SiriusClient({
    apiKey: vector.token,
    baseUrl: "https://staging.example/api/",
    fetch: fakeFetch([
      { status: 503, body: { error: { code: "enclave_starting", message: "starting" }, retryAfterSeconds: 20 }, headers: { "Retry-After": "7" } },
      { status: 200, body: ok },
    ], captured),
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    nonce: () => `nonce-fixture-${String(++nonce).padStart(4, "0")}`,
  });
  const result = await client.predict(vector.loanId, { age: 42, income: 51000.5 });
  assert.deepEqual(result, ok);
  assert.deepEqual(sleeps, [7000], "Retry-After prime");
  assert.equal(captured.length, 2);
  for (const request of captured) {
    assert.equal(request.url, `https://staging.example/api/v1/models/${vector.loanId}/predict`);
    assert.equal(request.method, "POST");
    assert.equal(request.body, vector.predict.body);
    assert.equal(request.headers["Sirius-Key"], vector.keyId);
    assert.equal(verifyApiSignature({
      secret: secretBytes,
      method: "POST",
      path: vector.predict.path,
      timestamp: Number(request.headers["Sirius-Timestamp"]),
      nonce: request.headers["Sirius-Nonce"],
      body: request.body,
      signature: request.headers["Sirius-Signature"],
    }), true);
  }
  assert.notEqual(captured[0].headers["Sirius-Nonce"], captured[1].headers["Sirius-Nonce"]);
  assert.equal(Number(captured[1].headers["Sirius-Timestamp"]) - Number(captured[0].headers["Sirius-Timestamp"]), 7);
  // Premier essai à l'horodatage du vecteur, nonce différent : signature différente du vecteur, mais même chaîne hors nonce.
  assert.equal(captured[0].headers["Sirius-Timestamp"], String(vector.predict.timestamp));
});

test("503 au-delà du délai maximal : erreur typée enclave_starting ; autres erreurs typées sans réessai", async () => {
  const sleeps: number[] = [];
  const starting = { status: 503, body: { error: { code: "enclave_starting", message: "starting" } }, headers: { "Retry-After": "30" } };
  const client = new SiriusClient({
    apiKey: vector.token,
    maxRetryWaitMs: 45_000,
    fetch: fakeFetch([starting, starting], []),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  await assert.rejects(client.info(vector.loanId), (error: unknown) => {
    assert.ok(error instanceof SiriusApiError);
    assert.equal(error.code, "enclave_starting");
    assert.equal(error.status, 503);
    assert.equal(error.retryAfterSeconds, 30);
    return true;
  });
  assert.deepEqual(sleeps, [30_000]);

  const captured: Captured[] = [];
  const refused = new SiriusClient({
    apiKey: vector.token,
    fetch: fakeFetch([{ status: 429, body: { error: { code: "quota_exceeded", message: "Quota du jour épuisé" } } }], captured),
    sleep: async () => { assert.fail("aucune attente hors 503"); },
  });
  await assert.rejects(refused.predict(vector.loanId, { age: 1 }), (error: unknown) => error instanceof SiriusApiError && error.code === "quota_exceeded" && error.status === 429);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, `https://api.sirius-data.tech/v1/models/${vector.loanId}/predict`);
  assert.throws(() => refused.predict(vector.loanId, { age: Number.NaN }));
});

test("réessai seul sur enclave_starting et runner_busy ; runner_unavailable ou 503 sans code remontent sans réessai (appel peut-être décompté)", async () => {
  const ok = { outputKind: "decision", decision: "1" };
  for (const [code, retried] of [["enclave_starting", true], ["runner_busy", true], ["runner_unavailable", false], [undefined, false]] as const) {
    const captured: Captured[] = [];
    const sleeps: number[] = [];
    const client = new SiriusClient({
      apiKey: vector.token,
      fetch: fakeFetch([
        { status: 503, body: code ? { error: { code, message: code } } : {}, headers: { "Retry-After": "1" } },
        { status: 200, body: ok },
      ], captured),
      sleep: async (ms) => { sleeps.push(ms); },
    });
    if (retried) {
      assert.deepEqual(await client.predict(vector.loanId, { age: 1 }), ok, code);
    } else {
      await assert.rejects(client.predict(vector.loanId, { age: 1 }), (error: unknown) =>
        error instanceof SiriusApiError && error.status === 503 && error.code === (code ?? "http_503"));
    }
    assert.equal(captured.length, retried ? 2 : 1, String(code));
    assert.deepEqual(sleeps, retried ? [1000] : [], String(code));
  }
});

test("info : GET signé sur le chemin public, corps vide", async () => {
  const captured: Captured[] = [];
  const client = new SiriusClient({
    apiKey: vector.token,
    fetch: fakeFetch([{ status: 200, body: { loanId: vector.loanId, modelId: "logistic_regression", modelVersion: "1.0.0", features: ["age"], expiresAt: 1, remaining: { today: 1, credits: 0 } } }], captured),
    now: () => vector.info.timestamp * 1000,
    nonce: () => vector.info.nonce,
  });
  await client.info(vector.loanId);
  assert.equal(captured[0].method, "GET");
  assert.equal(captured[0].body, "");
  assert.equal(captured[0].headers["Sirius-Signature"], vector.info.signature, "même entrée que le vecteur : même signature");
});

test("SDK Python : même chaîne canonique et même signature sur le vecteur partagé", (t) => {
  const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    t.skip("python3 absent");
    return;
  }
  const script = fileURLToPath(new URL("../python/sirius_api.py", import.meta.url));
  const child = spawnSync("python3", [script, "--self-test", vectorPath], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout) as Record<string, { canonical: string; signature: string }>;
  for (const name of ["predict", "info"] as const) {
    assert.equal(out[name].canonical, canonicalString({ ...vector[name] }));
    assert.equal(out[name].signature, vector[name].signature);
  }
});
