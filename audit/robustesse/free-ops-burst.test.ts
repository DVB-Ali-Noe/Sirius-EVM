/**
 * Opérations runner non facturées (handler.ts:176-189, PR #123) : `dataset-ingress-key` et
 * `self-train-key`. Mesure locale du calcul et des écritures disque qu'elles déclenchent, et
 * rafale pour vérifier l'absence de limite de débit dans le runner.
 *
 *   TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/robustesse/free-ops-burst.test.ts
 *
 * Tout est local : registre de budget et anti-rejeu SQLite dans un dossier temporaire, wallet
 * généré à la volée (aucun wallet existant), aucune chaîne ni réseau. AUDIT_BURST (défaut 200).
 *
 * Sous Windows, le runner refuse ses registres SQLite (droits POSIX 0600 invérifiables) : le test
 * passe alors en anti-rejeu mémoire, sans registre de budget, et ne mesure que le calcul. Les
 * écritures disque et le budget ne sont vérifiés que sous Linux (CVM, conteneur).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const BURST = Number(process.env.AUDIT_BURST ?? 200);
const directory = mkdtempSync(join(tmpdir(), "sirius-audit-burst-"));
chmodSync(directory, 0o700);
const wallet = `0x${"34".repeat(20)}`;
const PERSISTENT = process.platform !== "win32";

Object.assign(process.env, {
  NODE_ENV: "test",
  TEE_MODE: "stub",
  EVM_NETWORK: "testnet",
  SIRIUS_MASTER_KEY: randomBytes(32).toString("base64"),
  RUNNER_TRANSPORT_SECRET: randomBytes(32).toString("base64"),
  SIRIUS_APP_ORIGIN: "http://localhost:3000",
  SIRIUS_ESCROW_ADDRESS: `0x${"56".repeat(20)}`,
  SIRIUS_LOCK_AUTHORIZER: wallet,
});
if (PERSISTENT) Object.assign(process.env, { RUNNER_REPLAY_DIR: join(directory, "replay"), RUNNER_BUDGET_FILE: join(directory, "ledger.sqlite") });

type Modules = {
  handleRunnerRequest: typeof import("@/runner/server").handleRunnerRequest;
  issueRunnerCapability: typeof import("@/lib/runner/capability").issueRunnerCapability;
  runnerBudget: typeof import("@/lib/runner/budget").runnerBudget;
};
let modules: Modules;
const sqlite = process.getBuiltinModule("node:sqlite") as unknown as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => { prepare(sql: string): { get(): Record<string, unknown> | undefined }; close(): void };
};

function replayClaims(): number {
  if (!PERSISTENT) return 0;
  const db = new sqlite.DatabaseSync(join(directory, "replay", "replay.sqlite"), { readOnly: true });
  try { return Number(db.prepare("SELECT count(*) AS n FROM claims").get()?.n); } finally { db.close(); }
}

before(async () => {
  const { initializeRunnerReplay } = await import("@/lib/runner/replay");
  const { initializeBudgetLedger } = await import("@/lib/runner/budget-ledger");
  if (PERSISTENT) initializeRunnerReplay(join(directory, "replay"));
  if (PERSISTENT) initializeBudgetLedger(join(directory, "ledger.sqlite"), {
    version: 1, chainId: 46630, wallet, accountingReference: "audit-synthetic-not-revenue", validUntil: Date.now() + 3_600_000,
    earnedMarginUsdMicros: "1000000", cashUsdMicros: "1000000", fixedReserveUsdMicros: "100",
    costsUsdMicros: { request: "1", seal: "50", training: "100" },
    gas: { totalWei: "200000000000", maxTransactionWei: "100000000000", maxGas: "100000", maxFeePerGasWei: "1000000", ethUsdMicrosUpperBound: "5000000000", confirmations: 2 },
    maxFailures: 3, maxActive: 8,
  });
  modules = {
    handleRunnerRequest: (await import("@/runner/server")).handleRunnerRequest,
    issueRunnerCapability: (await import("@/lib/runner/capability")).issueRunnerCapability,
    runnerBudget: (await import("@/lib/runner/budget")).runnerBudget,
  };
});

after(() => {
  try { modules?.runnerBudget()?.close(); } catch { /* déjà fermé */ }
  rmSync(directory, { recursive: true, force: true });
});

async function call(op: string, scope: Record<string, string>, body: unknown): Promise<{ status: number; body: unknown }> {
  const text = JSON.stringify(body);
  const req = Readable.from([text]) as IncomingMessage;
  Object.assign(req, {
    method: "POST", url: `/${op}`,
    headers: { "x-sirius-runner-capability": modules.issueRunnerCapability(op as never, scope as never), "content-length": String(Buffer.byteLength(text)) },
  });
  let status = 0;
  let payload = "";
  const res = { writeHead(code: number) { status = code; return this; }, end(chunk: string) { payload = chunk; return this; } } as unknown as ServerResponse;
  await modules.handleRunnerRequest(req, res);
  return { status, body: JSON.parse(payload) as unknown };
}

function measure(label: string, before: { claims: number; usd: bigint }, started: number, cpu: NodeJS.CpuUsage, calls: number, statuses: number[]) {
  const ledger = modules.runnerBudget();
  const elapsed = performance.now() - started;
  const used = process.cpuUsage(cpu);
  const writes = replayClaims() - before.claims;
  const usd = ledger ? ledger.snapshot().allocatedUsd - before.usd : BigInt(0);
  const histogram = statuses.reduce<Record<number, number>>((acc, code) => ({ ...acc, [code]: (acc[code] ?? 0) + 1 }), {});
  console.log(`[${label}] ${calls} appels : ${(elapsed / calls).toFixed(2)} ms/appel (mur), ${((used.user + used.system) / 1000 / calls).toFixed(2)} ms CPU/appel, ` +
    `${PERSISTENT ? `${writes} lignes anti-rejeu SQLite écrites (${(writes / calls).toFixed(1)} par appel), budget alloué +${usd} µUSD` : "anti-rejeu mémoire (Windows)"}, statuts ${JSON.stringify(histogram)}`);
  return { writes, usd, histogram };
}

test(`dataset-ingress-key : ${BURST} appels en rafale — gratuit, mais une écriture SQLite synchronisée et un calcul EC par appel`, async () => {
  const before = { claims: replayClaims(), usd: (modules.runnerBudget()?.snapshot().allocatedUsd ?? BigInt(0)) };
  const started = performance.now();
  const cpu = process.cpuUsage();
  const statuses: number[] = [];
  for (let i = 0; i < BURST; i++) statuses.push((await call("dataset-ingress-key", {}, {})).status);
  const { writes, usd, histogram } = measure("dataset-ingress-key séquentiel", before, started, cpu, BURST, statuses);
  assert.equal(histogram[200], BURST, "aucune limite de débit dans le runner : tous les appels aboutissent");
  assert.equal(usd, BigInt(0), "aucun coût imputé au budget");
  if (PERSISTENT) assert.equal(writes, BURST, "une ligne anti-rejeu (capability) par appel");
});

test("dataset-ingress-key : 64 appels simultanés — seul le plafond de concurrence (8) répond, en 503 « Runner saturé »", async () => {
  const before = { claims: replayClaims(), usd: (modules.runnerBudget()?.snapshot().allocatedUsd ?? BigInt(0)) };
  const started = performance.now();
  const cpu = process.cpuUsage();
  const results = await Promise.all(Array.from({ length: 64 }, () => call("dataset-ingress-key", {}, {})));
  const { histogram } = measure("dataset-ingress-key concurrent", before, started, cpu, 64, results.map((r) => r.status));
  assert.equal((histogram[200] ?? 0) + (histogram[503] ?? 0), 64);
  const saturated = results.filter((r) => r.status === 503).map((r) => (r.body as { error?: string }).error);
  assert.ok(saturated.every((message) => message === "Runner saturé"));
});

test(`self-train-key : ${Math.min(BURST, 100)} re-livraisons en rafale — gratuites, mais 2 écritures SQLite, ECDSA secp256k1 + P-256 et ECDH par appel`, async () => {
  const { issueTrainingReceipt } = await import("@/lib/runner/receipt");
  const { useWalletStore } = await import("@/stores/wallet");
  const { activateRunnerDelegation, beginRunnerDelegation, issueRunnerGrant } = await import("@/lib/runner/authorization-client");
  const { buildDelegationMessage } = await import("@/lib/runner/authorization-contract");
  const account = privateKeyToAccount(generatePrivateKey());
  useWalletStore.getState().setConnected(account.address, "testnet", "external");
  const sessionPublicKey = await beginRunnerDelegation();
  const now = Date.now();
  const message = buildDelegationMessage({ origin: "http://localhost:3000", address: account.address, sessionPublicKey, network: "testnet", issuedAt: now, expiresAt: now + 600_000, challengeToken: "audit.local" });
  await activateRunnerDelegation({ message, walletSignature: await account.signMessage({ message }), sessionPublicKey });
  const jobId = "audit-job-1";
  const jobReceipt = issueTrainingReceipt({ jobId, datasetId: "audit-dataset", owner: account.address.toLowerCase(), modelCid: "bafy-audit", modelId: "logistic_regression", modelVersion: "1.0.0" });
  // Clé de livraison P-256 éphémère, comme le navigateur.
  const delivery = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const deliveryPublicKey = Buffer.from(await crypto.subtle.exportKey("raw", delivery.publicKey)).toString("base64url");

  const calls = Math.min(BURST, 100);
  const grants = [];
  for (let i = 0; i < calls; i++) grants.push(await issueRunnerGrant("self-train-key", { jobId }, [jobId, jobReceipt, deliveryPublicKey]));
  const before = { claims: replayClaims(), usd: (modules.runnerBudget()?.snapshot().allocatedUsd ?? BigInt(0)) };
  const started = performance.now();
  const cpu = process.cpuUsage();
  const statuses: number[] = [];
  let lastError: unknown;
  for (const authorization of grants) {
    const result = await call("self-train-key", { jobId }, { jobId, jobReceipt, deliveryPublicKey, authorization });
    statuses.push(result.status);
    if (result.status !== 200) lastError = result.body;
  }
  const { writes, usd, histogram } = measure("self-train-key séquentiel", before, started, cpu, calls, statuses);
  assert.equal(histogram[200], calls, `tous les appels aboutissent (${JSON.stringify(lastError)})`);
  assert.equal(usd, BigInt(0));
  if (PERSISTENT) assert.equal(writes, 2 * calls, "capability + grant consommés dans l'anti-rejeu persistant");
});
