import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initializeRunnerVolume } from "./initialize-runner-volume";
import { BudgetLedger } from "../src/lib/runner/budget-ledger";
import { checkRunnerReplay } from "../src/lib/runner/replay";

function policies() {
  const validUntil = Date.now() + 86400000;
  const budget = { version: 1, chainId: 46630, wallet: `0x${"12".repeat(20)}`, accountingReference: "synthetic-test-only",
    validUntil, earnedMarginUsdMicros: "1000000", cashUsdMicros: "1000000", fixedReserveUsdMicros: "1000",
    costsUsdMicros: { request: "1", seal: "10", training: "100" }, maxFailures: 3, maxActive: 8,
    gas: { totalWei: "1000000", maxTransactionWei: "100000", maxGas: "1000", maxFeePerGasWei: "100", ethUsdMicrosUpperBound: "1000", confirmations: 1 } };
  const profile = { computeAmount: "1000", maxFailureFee: "100", executionRateAtomicPerMs: "1", maxExecutionMs: 1000 };
  const billing = { version: 1, chainId: 46630, usdc: `0x${"34".repeat(20)}`, usdcDecimals: 18,
    computeRecipient: `0x${"56".repeat(20)}`, tariffVersion: "synthetic-test-only", costReference: "synthetic-test-only",
    validUntil, minimumComputeAmount: "1000", profiles: { linear_regression: profile, logistic_regression: profile } };
  return { budget, billing };
}

test("l'initialisation explicite prépare deux registres privés, conserve les grants historiques et refuse de recommencer", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sirius-volume-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "budget"));
  mkdirSync(join(root, "replay", "grant"), { recursive: true });
  const historical = join(root, "replay", "grant", "old");
  writeFileSync(historical, "reserved");
  const { budget, billing } = policies();
  initializeRunnerVolume(root, budget, billing);
  checkRunnerReplay(join(root, "replay"));
  const ledger = new BudgetLedger(join(root, "budget", "ledger.sqlite"), budget.chainId, budget.wallet);
  try { assert.equal(ledger.policy.accountingReference, "synthetic-test-only"); } finally { ledger.close(); }
  assert.equal(readFileSync(historical, "utf8"), "reserved");
  for (const path of ["budget", "replay", "budget/ledger.sqlite", "budget/budget-policy.json", "budget/billing-policy.json", "replay/replay.sqlite"]) {
    assert.equal(statSync(join(root, path)).mode & 0o077, 0);
  }
  assert.throws(() => initializeRunnerVolume(root, budget, billing), /déjà initialisé/);
});

test("une politique invalide ou non financée ne crée aucun fichier", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sirius-volume-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "budget")); mkdirSync(join(root, "replay"));
  const { budget, billing } = policies();
  for (const change of [{ chainId: 4663 }, { earnedMarginUsdMicros: "0" }, { cashUsdMicros: "0" },
    { validUntil: Date.now() - 1 }, { wallet: billing.computeRecipient }, { gas: { ...budget.gas, maxTransactionWei: "1" } }]) {
    assert.throws(() => initializeRunnerVolume(root, { ...budget, ...change }, billing));
  }
  for (const change of [{ usdcDecimals: 6 }, { chainId: 4663 }, { computeRecipient: `0x${"0".repeat(40)}` },
    { profiles: { ...billing.profiles, linear_regression: { ...billing.profiles.linear_regression, maxFailureFee: "1001" } } }]) {
    assert.throws(() => initializeRunnerVolume(root, budget, { ...billing, ...change }));
  }
  assert.deepEqual(readdirSync(join(root, "budget")), []);
  assert.deepEqual(readdirSync(join(root, "replay")), []);
});

test("un volume partiel ou un journal orphelin n'est jamais réinitialisé", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sirius-volume-partial-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "budget")); mkdirSync(join(root, "replay"));
  writeFileSync(join(root, "budget", "ledger.sqlite-wal"), "historical");
  const { budget, billing } = policies();
  assert.throws(() => initializeRunnerVolume(root, budget, billing), /incomplet/);
  assert.equal(readFileSync(join(root, "budget", "ledger.sqlite-wal"), "utf8"), "historical");
  assert.deepEqual(readdirSync(join(root, "replay")), []);
});

test("la commande vérifie les comptes de la cible avant d'initialiser les volumes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "sirius-volume-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "budget")); mkdirSync(join(root, "replay"));
  const { budget, billing } = policies();
  const env = { PATH: process.env.PATH, NODE_ENV: "production" as const, RUNNER_VOLUME_ACTION: "initialize-new-v7-volume",
    SIRIUS_LOCK_AUTHORIZER: budget.wallet, SIRIUS_USDC_ADDRESS: billing.usdc, SIRIUS_COMPUTE_RECIPIENT: billing.computeRecipient,
    RUNNER_INITIAL_BUDGET_POLICY: JSON.stringify(budget), RUNNER_INITIAL_BILLING_POLICY: JSON.stringify(billing) };
  const args = ["--conditions=react-server", "--import", "tsx", "scripts/initialize-runner-volume.ts", root];
  const execute = promisify(execFile);
  await assert.rejects(execute(process.execPath, args, { env: { ...env, SIRIUS_LOCK_AUTHORIZER: billing.computeRecipient }, timeout: 10000 }), { code: 1 });
  assert.deepEqual(readdirSync(join(root, "budget")), []);
  assert.deepEqual(readdirSync(join(root, "replay")), []);
  const result = await execute(process.execPath, args, { env, timeout: 10000 });
  assert.match(result.stdout, /Volumes v7 initialisés/);
  checkRunnerReplay(join(root, "replay"));
});
