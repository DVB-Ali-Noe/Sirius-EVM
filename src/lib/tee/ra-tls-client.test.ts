import assert from "node:assert/strict";
import { Agent, createServer, request as httpRequest, type Server } from "node:http";
import type { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import {
  RUNNER_HEADERS_TIMEOUT_MS,
  RUNNER_KEEP_ALIVE_TIMEOUT_MS,
  RUNNER_REQUEST_TIMEOUT_MS,
} from "@/runner/server";
import {
  bufferedRequest,
  dropIdleSockets,
  isStaleSocketError,
  RUNNER_AGENT_KEEP_ALIVE,
  RUNNER_CLIENT_IDLE_MS,
  RunnerAttestationError,
  runnerFailureDiagnostic,
  RunnerTransportError,
  withStaleSocketRetry,
} from "./ra-tls-client";
import { RETRYABLE_RUNNER_OPS } from "./runner-client";
import { verifyQuoteHardware, type HardwareVerifierIO } from "./quote";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Serveur HTTP réglé comme le runner (src/runner/server.ts) ; le transport TLS ne change rien au
// keep-alive. `mode` décide du traitement de chaque requête.
let server: Server;
let port = 0;
let received = 0;
let mode: "ok" | "slow" | "reset-second" = "ok";

before(async () => {
  server = createServer((req, res) => {
    received += 1;
    if (mode === "reset-second" && received === 2) {
      // Le runner ferme la connexion keep-alive au moment où la requête arrive, sans la traiter.
      req.socket.destroy();
      return;
    }
    req.resume();
    req.on("end", () => {
      const reply = () => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); };
      if (mode === "slow") setTimeout(reply, RUNNER_CLIENT_IDLE_MS + 1_000); else reply();
    });
  });
  server.headersTimeout = RUNNER_HEADERS_TIMEOUT_MS;
  server.requestTimeout = RUNNER_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = RUNNER_KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = 20;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => { server?.close(); });

function call(agent: Agent, timeoutMs = 20_000) {
  return bufferedRequest(new URL(`http://127.0.0.1:${port}/self-train-key`), {
    agent: agent as never,
    body: Buffer.from("{}"),
    headers: new Headers({ "content-type": "application/json", "content-length": "2" }),
    maxBytes: 1024,
    method: "POST",
    rejectUnauthorized: true,
    timeoutMs,
    requestImpl: httpRequest as unknown as typeof httpsRequest,
  });
}

function freeSocketCount(agent: Agent): number {
  return Object.values(agent.freeSockets).reduce((total, sockets) => total + (sockets?.length ?? 0), 0);
}

test("ROB-10 : le délai d’inactivité du client reste bien sous celui du runner", () => {
  assert.equal(RUNNER_AGENT_KEEP_ALIVE.timeout, RUNNER_CLIENT_IDLE_MS);
  assert.ok(RUNNER_KEEP_ALIVE_TIMEOUT_MS - RUNNER_CLIENT_IDLE_MS >= 5_000, "marge pour la latence de la passerelle");
  assert.ok(RUNNER_HEADERS_TIMEOUT_MS > RUNNER_KEEP_ALIVE_TIMEOUT_MS);
});

test("ROB-10 : Next ferme lui-même une connexion inactive avant que le runner ne le fasse", async () => {
  mode = "ok";
  received = 0;
  const agent = new Agent(RUNNER_AGENT_KEEP_ALIVE);
  try {
    assert.equal((await call(agent)).status, 200);
    await wait(50);
    assert.equal(freeSocketCount(agent), 1, "connexion gardée pour la requête suivante");
    await wait(RUNNER_CLIENT_IDLE_MS + 500);
    assert.equal(freeSocketCount(agent), 0, "connexion inactive fermée côté client");
    assert.equal((await call(agent)).status, 200);
  } finally {
    agent.destroy();
  }
});

test("ROB-10 : une requête longue (entraînement) n’est pas coupée par le délai d’inactivité", async () => {
  mode = "slow";
  const agent = new Agent(RUNNER_AGENT_KEEP_ALIVE);
  try {
    assert.equal((await call(agent)).status, 200);
  } finally {
    agent.destroy();
    mode = "ok";
  }
});

test("ROB-10 : une connexion périmée est rejouée une fois pour une opération sans effet de bord", async () => {
  mode = "reset-second";
  received = 0;
  const agent = new Agent(RUNNER_AGENT_KEEP_ALIVE);
  try {
    assert.equal((await call(agent)).status, 200);
    const response = await withStaleSocketRetry((timeoutMs) => call(agent, timeoutMs), 20_000, true, () => dropIdleSockets(agent));
    assert.equal(response.status, 200);
    assert.equal(received, 3, "une coupure, puis un seul nouvel essai");
  } finally {
    agent.destroy();
    mode = "ok";
  }
});

test("ROB-10 : jamais de nouvel essai pour une opération qui engage un calcul, un paiement ou un règlement", async () => {
  mode = "reset-second";
  received = 0;
  const agent = new Agent(RUNNER_AGENT_KEEP_ALIVE);
  try {
    assert.equal((await call(agent)).status, 200);
    await assert.rejects(withStaleSocketRetry((timeoutMs) => call(agent, timeoutMs), 20_000, false), (error: unknown) => {
      assert.ok(error instanceof RunnerTransportError);
      assert.equal(error.reusedSocket, true);
      assert.equal(error.responseStarted, false);
      assert.equal(isStaleSocketError(error), true);
      return true;
    });
    assert.equal(received, 2, "aucune requête renvoyée");
  } finally {
    agent.destroy();
    mode = "ok";
  }
  for (const op of ["seal-dataset", "prepare-escrow-lock", "run-loan-job", "settle-loan", "recover-loan-job", "loan-model-key", "run-training"] as const) {
    assert.equal(RETRYABLE_RUNNER_OPS.has(op), false, op);
  }
  assert.deepEqual([...RETRYABLE_RUNNER_OPS].sort(), ["dataset-ingress-key", "self-train-key"]);
});

test("ROB-10 : seule une coupure sur socket réutilisé, avant toute réponse, autorise le nouvel essai", async () => {
  assert.equal(isStaleSocketError(new RunnerTransportError("ECONNRESET", true, false, null)), true);
  assert.equal(isStaleSocketError(new RunnerTransportError("EPIPE", true, false, null)), true);
  assert.equal(isStaleSocketError(new RunnerTransportError("ECONNRESET", false, false, null)), false, "connexion neuve");
  assert.equal(isStaleSocketError(new RunnerTransportError("ECONNRESET", true, true, null)), false, "réponse entamée");
  assert.equal(isStaleSocketError(new RunnerTransportError("ABORT_ERR", true, false, null)), false, "délai dépassé");
  assert.equal(isStaleSocketError(new Error("ECONNRESET")), false);
  let attempts = 0;
  await assert.rejects(withStaleSocketRetry(async () => {
    attempts += 1;
    throw new RunnerTransportError("ECONNRESET", true, false, null);
  }, 20_000, true), RunnerTransportError);
  assert.equal(attempts, 2, "un seul nouvel essai, jamais une boucle");
  let late = 0;
  let clock = 0;
  await assert.rejects(withStaleSocketRetry(async () => {
    late += 1;
    clock += 19_500;
    throw new RunnerTransportError("ECONNRESET", true, false, null);
  }, 20_000, true, () => {}, () => clock), RunnerTransportError);
  assert.equal(late, 1, "pas de nouvel essai sans délai restant");
});

test("ROB-10/11 : le diagnostic journalisé donne la cause sans corps ni en-tête", () => {
  assert.equal(runnerFailureDiagnostic(new RunnerTransportError("ECONNRESET", true, false, new Error("socket hang up"))),
    "réseau (code=ECONNRESET, socket réutilisé=oui, réponse entamée=non)");
  assert.equal(runnerFailureDiagnostic(new RunnerAttestationError("x", "collateral-unavailable")), "attestation (collateral-unavailable)");
  assert.equal(runnerFailureDiagnostic(new RunnerAttestationError("x", "transport", new RunnerTransportError("ETIMEDOUT", false, false, null))),
    "attestation (transport : réseau (code=ETIMEDOUT, socket réutilisé=non, réponse entamée=non))");
});

function hardwareIO(change: Partial<HardwareVerifierIO>): HardwareVerifierIO {
  return {
    getCollateral: async () => ({}) as never,
    verify: () => ({ status: "UpToDate" }),
    now: () => 1_700_000_000_000,
    timeoutMs: 50,
    retryDelayMs: 1,
    ...change,
  };
}

test("ROB-11 : un échec passager de la collatérale est rattrapé par un nouvel essai", async () => {
  let calls = 0;
  const result = await verifyQuoteHardware(Buffer.from("00", "hex"), hardwareIO({
    getCollateral: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return {} as never;
    },
  }));
  assert.deepEqual(result, { status: "UpToDate" });
  assert.equal(calls, 2);
});

test("ROB-11 : un PCCS muet ne bloque pas la requête : délai par tentative, cause « collatérale indisponible »", async () => {
  let calls = 0;
  const started = Date.now();
  const result = await verifyQuoteHardware(Buffer.from("00", "hex"), hardwareIO({
    getCollateral: () => { calls += 1; return new Promise<never>(() => {}); },
  }));
  assert.deepEqual(result, { failure: "collateral-unavailable" });
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 2_000);
});

test("ROB-11 : une quote refusée par la vérification n’est pas rejouée et reste distinguée du réseau", async () => {
  let calls = 0;
  const result = await verifyQuoteHardware(Buffer.from("00", "hex"), hardwareIO({
    getCollateral: async () => { calls += 1; return {} as never; },
    verify: () => { throw new Error("signature invalide"); },
  }));
  assert.deepEqual(result, { failure: "rejected" });
  assert.equal(calls, 1);
});
