import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AppError } from "../src/lib/app-error";
import { BudgetLedger, initializeBudgetLedger, renewSponsoredBudgetPolicy, type BudgetPolicy } from "../src/lib/runner/budget-ledger";
import { RENEWAL_ACTOR } from "./renew-runner-budget-policy";

interface Sqlite {
  prepare(sql: string): { get(): Record<string, unknown> | undefined; all(): Record<string, unknown>[] };
  close(): void;
}
// Les types Node installés ne déclarent pas `node:sqlite` : même contournement que budget-ledger.ts.
const sqlite = process.getBuiltinModule("node:sqlite") as unknown as { DatabaseSync: new (path: string, options: { readOnly: boolean }) => Sqlite };
const { DatabaseSync } = sqlite;

const DAY = 86_400_000;
const wallet = `0x${"12".repeat(20)}`;

function sponsoredVolume(t: { after: (fn: () => void) => void }, change: (p: BudgetPolicy) => void = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "sirius-budget-renewal-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const observedAtMs = Date.now() - 20 * DAY;
  const policy: BudgetPolicy = {
    version: 1, chainId: 46630, wallet, accountingReference: "synthetic-renewal", validUntil: observedAtMs + 30 * DAY,
    earnedMarginUsdMicros: "0", cashUsdMicros: "0", fixedReserveUsdMicros: "100",
    costsUsdMicros: { request: "1", seal: "50", training: "100" },
    gas: { totalWei: "200000000000", maxTransactionWei: "100000000000", maxGas: "100000", maxFeePerGasWei: "1000000", ethUsdMicrosUpperBound: "5000000000", confirmations: 2 },
    maxFailures: 3, maxActive: 8,
    sponsored: { funding: "credits", creditsUsdMicros: "100000", cashUsdMicros: "0", ceilingUsdMicros: "90000",
      maxOperations: 6, maxOperationsPerWallet: 2, maxConcurrent: 1, origin: "https://demo.example", observedAtMs },
  };
  change(policy);
  const path = join(directory, "ledger.sqlite");
  initializeBudgetLedger(path, policy);
  // Activité réelle avant expiration : opérations réussie, échouée et en cours.
  if (policy.validUntil <= Date.now()) return { path, policy };
  const ledger = new BudgetLedger(path, policy.chainId, wallet);
  try {
    ledger.reserve("request:1", "fp-1", "request");
    ledger.finish("request:1", "fp-1", true, "ok");
    ledger.reserve("training:2", "fp-2", "training");
    ledger.finish("training:2", "fp-2", false);
    ledger.reserve("training:3", "fp-3", "training");
  } finally { ledger.close(); }
  return { path, policy };
}

/** Toutes les tables, sauf la politique elle-même et son historique, sérialisées ligne à ligne. */
function dump(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sponsored_policy_changes' ORDER BY name").all()
      .map((row) => String(row.name));
    return Object.fromEntries(tables.map((name) => [name, JSON.stringify(name === "budget"
      ? db.prepare("SELECT id, allocated_usd, allocated_wei, failures FROM budget").all()
      : db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all())]));
  } finally { db.close(); }
}

function storedPolicy(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return String(db.prepare("SELECT policy FROM budget WHERE id = 1").get()?.policy); } finally { db.close(); }
}

function history(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sponsored_policy_changes'").get();
    return exists ? Number(db.prepare("SELECT count(*) AS n FROM sponsored_policy_changes").get()?.n) : 0;
  } finally { db.close(); }
}

test("prolonge la validité dans le registre réel sans toucher aux compteurs, réservations ni financement", (t) => {
  const { path, policy } = sponsoredVolume(t);
  const before = dump(path);
  const previous = storedPolicy(path);
  const renewal = { validUntil: Date.now() + 30 * DAY, observedAtMs: Date.now() - 1000 };
  const result = renewSponsoredBudgetPolicy(path, 46630, wallet, renewal, RENEWAL_ACTOR);
  assert.equal(result.status, "renewed");
  assert.deepEqual(dump(path), before, "compteurs, opérations et flux identiques");
  const expected = JSON.parse(previous) as BudgetPolicy;
  expected.validUntil = renewal.validUntil;
  expected.sponsored!.observedAtMs = renewal.observedAtMs;
  assert.equal(storedPolicy(path), JSON.stringify(expected), "seules validUntil et observedAtMs changent");
  assert.equal(history(path), 1);
  const ledger = new BudgetLedger(path, policy.chainId, wallet);
  try {
    assert.equal(ledger.policy.validUntil, renewal.validUntil);
    const diagnostics = ledger.diagnostics();
    assert.deepEqual([diagnostics.expired, diagnostics.failures, diagnostics.incompleteJobs], [false, 1, 1]);
  } finally { ledger.close(); }
});

test("une politique déjà expirée se prolonge aussi, le runner pouvant alors redémarrer", (t) => {
  const { path } = sponsoredVolume(t, (p) => { p.sponsored!.observedAtMs = Date.now() - 32 * DAY; p.validUntil = Date.now() - 2 * DAY; });
  renewSponsoredBudgetPolicy(path, 46630, wallet, { validUntil: Date.now() + 10 * DAY, observedAtMs: Date.now() }, RENEWAL_ACTOR);
  const ledger = new BudgetLedger(path, 46630, wallet);
  try { assert.equal(ledger.diagnostics().expired, false); } finally { ledger.close(); }
});

test("refuse de raccourcir, de dépasser 31 jours, de reculer le relevé ou de modifier autre chose", (t) => {
  const { path, policy } = sponsoredVolume(t);
  const now = Date.now();
  const previous = storedPolicy(path);
  const refused: [unknown, string, number?][] = [
    [{ validUntil: policy.validUntil - 1, observedAtMs: now }, "raccourcir"],
    [{ validUntil: policy.validUntil, observedAtMs: now }, "même échéance, autre relevé"],
    [{ validUntil: now + 32 * DAY, observedAtMs: now }, "plus de 31 jours après le relevé"],
    [{ validUntil: policy.validUntil + DAY, observedAtMs: policy.sponsored!.observedAtMs - 1 }, "relevé antérieur"],
    [{ validUntil: now + 10 * DAY, observedAtMs: now + 60_000 }, "relevé futur"],
    [{ validUntil: now + 10 * DAY, observedAtMs: now, sponsored: { ceilingUsdMicros: "1" } }, "financement"],
    [{ validUntil: now + 10 * DAY, observedAtMs: now, maxFailures: 100 }, "plafond"],
    [{ validUntil: now + 10 * DAY }, "relevé absent"],
    [{ validUntil: now + 10 * DAY, observedAtMs: now }, "autre réseau", 4663],
  ];
  for (const [value, label, chainId] of refused) {
    assert.throws(() => renewSponsoredBudgetPolicy(path, chainId ?? 46630, wallet, value, RENEWAL_ACTOR), AppError, label);
  }
  assert.throws(() => renewSponsoredBudgetPolicy(path, 46630, `0x${"13".repeat(20)}`, { validUntil: now + 10 * DAY, observedAtMs: now }, RENEWAL_ACTOR), /wallet/);
  assert.equal(storedPolicy(path), previous, "rien n'a été modifié");
  assert.equal(history(path), 0);
  chmodSync(path, 0o644);
  assert.throws(() => renewSponsoredBudgetPolicy(path, 46630, wallet, { validUntil: now + 10 * DAY, observedAtMs: now }, RENEWAL_ACTOR), /privé/);
});

test("hors démonstration sponsorisée, le budget ne se prolonge pas par cet outil", (t) => {
  const { path } = sponsoredVolume(t, (p) => { delete p.sponsored; p.earnedMarginUsdMicros = p.cashUsdMicros = "1000"; });
  assert.throws(() => renewSponsoredBudgetPolicy(path, 46630, wallet, { validUntil: Date.now() + 40 * DAY, observedAtMs: Date.now() }, RENEWAL_ACTOR), /sponsorisé/);
});

test("reprise après coupure : rien d'appliqué si la transaction est interrompue, rejeu sans effet après validation", async (t) => {
  const { path, policy } = sponsoredVolume(t);
  const previous = storedPolicy(path);
  // Un processus prend le verrou d'écriture, modifie la politique sans valider, puis est tué.
  // Le canal IPC ouvert le garde en vie jusqu'au SIGKILL.
  const script = `
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE");
    db.prepare("UPDATE budget SET policy = '{}' WHERE id = 1").run();
    process.send("ready");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script, path], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = once(child, "exit");
  await once(child, "message");
  child.kill("SIGKILL");
  assert.equal((await exited)[1], "SIGKILL");
  assert.equal(storedPolicy(path), previous, "coupure avant validation : ancienne politique");

  const renewal = { validUntil: policy.validUntil + 5 * DAY, observedAtMs: Date.now() - 1000 };
  assert.equal(renewSponsoredBudgetPolicy(path, 46630, wallet, renewal, RENEWAL_ACTOR).status, "renewed");
  const applied = storedPolicy(path);
  // Coupure après validation, avant le message de sortie : la relance identique ne réécrit rien.
  assert.equal(renewSponsoredBudgetPolicy(path, 46630, wallet, renewal, RENEWAL_ACTOR).status, "already-applied");
  assert.equal(storedPolicy(path), applied);
  assert.equal(history(path), 1);
});

test("la commande exige son action, le réseau, le signataire et une demande approuvée", async (t) => {
  const { path, policy } = sponsoredVolume(t);
  const renewal = JSON.stringify({ validUntil: policy.validUntil + DAY, observedAtMs: Date.now() - 1000 });
  const env = { PATH: process.env.PATH, NODE_ENV: "production" as const, RUNNER_VOLUME_ACTION: "renew-budget-policy",
    EVM_NETWORK: "testnet", SIRIUS_LOCK_AUTHORIZER: wallet, RUNNER_BUDGET_RENEWAL: renewal };
  const args = ["--conditions=react-server", "--import", "tsx", "scripts/renew-runner-budget-policy.ts", path];
  const execute = promisify(execFile);
  for (const change of [{ RUNNER_VOLUME_ACTION: "update-billing-policy" }, { EVM_NETWORK: "mainnet" }, { SIRIUS_LOCK_AUTHORIZER: `0x${"13".repeat(20)}` }, { RUNNER_BUDGET_RENEWAL: "{}" }]) {
    await assert.rejects(execute(process.execPath, args, { env: { ...env, ...change }, timeout: 10000 }), { code: 1 });
  }
  assert.equal(history(path), 0);
  const result = await execute(process.execPath, args, { env, timeout: 10000 });
  assert.match(result.stdout, /Budget prolongé/);
  assert.match((await execute(process.execPath, args, { env, timeout: 10000 })).stdout, /déjà appliquée/);
});
