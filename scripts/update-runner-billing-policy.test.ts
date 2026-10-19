import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { initializeRunnerVolume, RUNNER_VOLUME_NETWORKS } from "./initialize-runner-volume";
import { updateRunnerBillingPolicy } from "./update-runner-billing-policy";
import { BudgetLedger } from "../src/lib/runner/budget-ledger";

const profile = { computeAmount: "1000", maxFailureFee: "100", executionRateAtomicPerMs: "1", maxExecutionMs: 1000 };

function installedVolume(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "sirius-billing-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "budget"));
  mkdirSync(join(root, "replay"));
  const validUntil = Date.now() + 86400000;
  const budget = { version: 1, chainId: 46630, wallet: `0x${"12".repeat(20)}`, accountingReference: "synthetic-test-only",
    validUntil, earnedMarginUsdMicros: "1000000", cashUsdMicros: "1000000", fixedReserveUsdMicros: "1000",
    costsUsdMicros: { request: "1", seal: "10", training: "100" }, maxFailures: 3, maxActive: 8,
    gas: { totalWei: "1000000", maxTransactionWei: "100000", maxGas: "1000", maxFeePerGasWei: "100", ethUsdMicrosUpperBound: "1000", confirmations: 1 } };
  const billing = { version: 1, chainId: 46630, usdc: `0x${"34".repeat(20)}`, usdcDecimals: 18,
    computeRecipient: `0x${"56".repeat(20)}`, tariffVersion: "installed-v1", costReference: "synthetic-test-only",
    validUntil: validUntil - 1000, minimumComputeAmount: "1000", profiles: { linear_regression: profile, logistic_regression: profile } };
  initializeRunnerVolume(root, budget, billing);
  const withTrees = { ...billing, tariffVersion: "installed-v2", profiles: { ...billing.profiles, gradient_boosted_trees: profile } };
  return { root, budget, billing, withTrees, directory: join(root, "budget") };
}

const read = (directory: string) => JSON.parse(readFileSync(join(directory, "billing-policy.json"), "utf8"));

test("ajoute le tarif arbres à un volume déjà initialisé sans toucher au registre budgétaire", (t) => {
  const { budget, billing, withTrees, directory } = installedVolume(t);
  const ledgerBefore = readFileSync(join(directory, "ledger.sqlite"));
  const result = updateRunnerBillingPolicy(directory, withTrees, RUNNER_VOLUME_NETWORKS.testnet, 1_000);
  assert.deepEqual(result.addedProfiles, ["gradient_boosted_trees"]);
  assert.deepEqual(result.changedProfiles, []);
  assert.equal(result.previousTariffVersion, "installed-v1");
  assert.deepEqual(read(directory), withTrees);
  assert.deepEqual(JSON.parse(readFileSync(result.backup, "utf8")), billing);
  for (const file of ["billing-policy.json", "billing-policy.previous-1000.json"]) assert.equal(statSync(join(directory, file)).mode & 0o077, 0);
  assert.ok(readFileSync(join(directory, "ledger.sqlite")).equals(ledgerBefore), "registre budgétaire inchangé");
  const ledger = new BudgetLedger(join(directory, "ledger.sqlite"), budget.chainId, budget.wallet);
  try { assert.equal(ledger.policy.accountingReference, "synthetic-test-only"); } finally { ledger.close(); }
});

test("refuse un autre réseau, jeton ou trésorerie, un profil retiré, une version identique ou une validité trop longue", (t) => {
  const { budget, billing, withTrees, directory } = installedVolume(t);
  const refused: unknown[] = [
    { ...withTrees, usdc: `0x${"35".repeat(20)}` },
    { ...withTrees, computeRecipient: `0x${"57".repeat(20)}` },
    { ...withTrees, profiles: { linear_regression: profile, gradient_boosted_trees: profile } },
    { ...withTrees, tariffVersion: billing.tariffVersion },
    { ...withTrees, validUntil: budget.validUntil + 1 },
    { ...withTrees, profiles: { ...withTrees.profiles, gradient_boosted_trees: { ...profile, maxFailureFee: "1001" } } },
    { ...withTrees, profiles: { ...withTrees.profiles, gradient_boosted_trees: { ...profile, maxExecutionMs: 30_001 } } },
    { ...withTrees, validUntil: Date.now() - 1 },
  ];
  for (const value of refused) assert.throws(() => updateRunnerBillingPolicy(directory, value, RUNNER_VOLUME_NETWORKS.testnet), JSON.stringify(value).slice(0, 80));
  assert.throws(() => updateRunnerBillingPolicy(directory, withTrees, RUNNER_VOLUME_NETWORKS.mainnet));
  assert.deepEqual(read(directory), billing, "rien n'a été remplacé");
  assert.deepEqual(readdirSync(directory).filter((name) => name.startsWith("billing-policy.previous")), []);
});

test("un volume sans tarif installé n'est jamais initialisé par la mise à jour", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sirius-billing-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { withTrees } = installedVolume(t);
  assert.throws(() => updateRunnerBillingPolicy(root, withTrees, RUNNER_VOLUME_NETWORKS.testnet));
  assert.deepEqual(readdirSync(root), []);
});

test("la commande exige son action explicite et les comptes de la cible", async (t) => {
  const { billing, withTrees, directory } = installedVolume(t);
  const env = { PATH: process.env.PATH, NODE_ENV: "production" as const, RUNNER_VOLUME_ACTION: "update-billing-policy", EVM_NETWORK: "testnet",
    SIRIUS_USDC_ADDRESS: billing.usdc, SIRIUS_COMPUTE_RECIPIENT: billing.computeRecipient, RUNNER_UPDATED_BILLING_POLICY: JSON.stringify(withTrees) };
  const args = ["--conditions=react-server", "--import", "tsx", "scripts/update-runner-billing-policy.ts", directory];
  const execute = promisify(execFile);
  for (const change of [{ RUNNER_VOLUME_ACTION: "initialize-new-v7-volume" }, { SIRIUS_COMPUTE_RECIPIENT: `0x${"57".repeat(20)}` }, { EVM_NETWORK: "mainnet" }]) {
    await assert.rejects(execute(process.execPath, args, { env: { ...env, ...change }, timeout: 10000 }), { code: 1 });
  }
  assert.deepEqual(read(directory), billing);
  const result = await execute(process.execPath, args, { env, timeout: 10000 });
  assert.match(result.stdout, /profils ajoutés : gradient_boosted_trees/);
  assert.deepEqual(read(directory), withTrees);
});
