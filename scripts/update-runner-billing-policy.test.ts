import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { initializeRunnerVolume, RUNNER_VOLUME_NETWORKS } from "./initialize-runner-volume";
import { updateRunnerBillingPolicy } from "./update-runner-billing-policy";
import { BudgetLedger, renewSponsoredBudgetPolicy } from "../src/lib/runner/budget-ledger";

const profile = { computeAmount: "1000", maxFailureFee: "100", executionRateAtomicPerMs: "1", maxExecutionMs: 1000 };
const testnet = RUNNER_VOLUME_NETWORKS.testnet;
const json = (value: unknown) => JSON.stringify(value);

function installedVolume(t: { after: (fn: () => void) => void }, sponsored = false) {
  const root = mkdtempSync(join(tmpdir(), "sirius-billing-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "budget"));
  mkdirSync(join(root, "replay"));
  const validUntil = Date.now() + 86400000;
  const budget = { version: 1, chainId: 46630, wallet: `0x${"12".repeat(20)}`, accountingReference: "synthetic-test-only",
    validUntil, earnedMarginUsdMicros: sponsored ? "0" : "1000000", cashUsdMicros: sponsored ? "0" : "1000000", fixedReserveUsdMicros: "1000",
    costsUsdMicros: { request: "1", seal: "10", training: "100" }, maxFailures: 3, maxActive: 8,
    gas: { totalWei: "1000000", maxTransactionWei: "100000", maxGas: "1000", maxFeePerGasWei: "100", ethUsdMicrosUpperBound: "1000", confirmations: 1 },
    ...(sponsored ? { sponsored: { funding: "credits", creditsUsdMicros: "1000000", cashUsdMicros: "0", ceilingUsdMicros: "900000",
      maxOperations: 6, maxOperationsPerWallet: 2, maxConcurrent: 1, origin: "https://demo.example", observedAtMs: Date.now() - 1000 } } : {}) };
  const billing = { version: 1, chainId: 46630, usdc: `0x${"34".repeat(20)}`, usdcDecimals: 18,
    computeRecipient: `0x${"56".repeat(20)}`, tariffVersion: "installed-v1", costReference: "synthetic-test-only",
    validUntil: validUntil - 1000, minimumComputeAmount: "1000", noTrainingComputeAmount: "100", apiCallsPerDay: { logistic_regression: 50 },
    profiles: { linear_regression: profile, logistic_regression: profile } };
  initializeRunnerVolume(root, budget, billing);
  const withTrees = { ...billing, tariffVersion: "installed-v2", profiles: { ...billing.profiles, gradient_boosted_trees: profile } };
  return { root, budget, billing, withTrees, directory: join(root, "budget") };
}

const read = (directory: string) => JSON.parse(readFileSync(join(directory, "billing-policy.json"), "utf8"));

test("ajoute le tarif arbres à un volume déjà initialisé sans toucher au registre budgétaire", (t) => {
  const { budget, billing, withTrees, directory } = installedVolume(t);
  const ledgerBefore = readFileSync(join(directory, "ledger.sqlite"));
  const result = updateRunnerBillingPolicy(directory, json(withTrees), testnet, { now: 1_000 });
  assert.deepEqual(result.addedProfiles, ["gradient_boosted_trees"]);
  assert.deepEqual(result.changedProfiles, []);
  assert.equal(result.previousTariffVersion, "installed-v1");
  assert.equal(readFileSync(join(directory, "billing-policy.json"), "utf8"), json(withTrees), "octets fournis écrits tels quels");
  assert.equal(result.sha256, createHash("sha256").update(json(withTrees)).digest("hex"));
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "billing-policy.previous-1000.json"), "utf8")), billing);
  assert.equal(result.backup, join(directory, "billing-policy.previous-1000.json"));
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
  for (const value of refused) assert.throws(() => updateRunnerBillingPolicy(directory, json(value), testnet), json(value).slice(0, 80));
  assert.throws(() => updateRunnerBillingPolicy(directory, json(withTrees), RUNNER_VOLUME_NETWORKS.mainnet));
  assert.deepEqual(read(directory), billing, "rien n'a été remplacé");
  assert.deepEqual(readdirSync(directory).filter((name) => name.startsWith("billing-policy.previous")), []);
});

test("un prix installé ne change qu'avec l'option explicite", (t) => {
  const { billing, withTrees, directory } = installedVolume(t);
  const repriced = { ...withTrees, profiles: { ...withTrees.profiles, logistic_regression: { ...profile, computeAmount: "2000" } } };
  assert.throws(() => updateRunnerBillingPolicy(directory, json(repriced), testnet), /option explicite/);
  assert.throws(() => updateRunnerBillingPolicy(directory, json({ ...withTrees, minimumComputeAmount: "1" }), testnet), /option explicite/);
  assert.deepEqual(read(directory), billing);
  const result = updateRunnerBillingPolicy(directory, json(repriced), testnet, { allowProfileChanges: true });
  assert.deepEqual(result.changedProfiles, ["logistic_regression"]);
});

test("frais sans entraînement et quotas d'API installés ne changent qu'avec l'option ; un nouveau quota est libre", (t) => {
  const { billing, withTrees, directory } = installedVolume(t);
  for (const changed of [
    { ...withTrees, noTrainingComputeAmount: "200" },
    { ...withTrees, apiCallsPerDay: { logistic_regression: 60 } },
    { ...withTrees, apiCallsPerDay: {} },
  ]) assert.throws(() => updateRunnerBillingPolicy(directory, json(changed), testnet), /option explicite/);
  assert.deepEqual(read(directory), billing);
  const added = { ...withTrees, apiCallsPerDay: { logistic_regression: 50, gradient_boosted_trees: 100 } };
  assert.equal(updateRunnerBillingPolicy(directory, json(added), testnet).status, "updated");
});

test("un tarif installé avant l'API reçoit ses frais sans entraînement et ses quotas sans option", (t) => {
  const { billing, withTrees, directory } = installedVolume(t);
  const legacy = Object.fromEntries(Object.entries(billing).filter(([key]) => key !== "noTrainingComputeAmount" && key !== "apiCallsPerDay"));
  writeFileSync(join(directory, "billing-policy.json"), json(legacy), { mode: 0o600 });
  assert.equal(updateRunnerBillingPolicy(directory, json(withTrees), testnet).status, "updated");
  assert.deepEqual(read(directory), withTrees);
});

test("un tarif identique écrit dans un autre ordre de clés n'est pas un changement de prix", (t) => {
  const { withTrees, directory } = installedVolume(t);
  const reordered = { maxExecutionMs: profile.maxExecutionMs, executionRateAtomicPerMs: profile.executionRateAtomicPerMs,
    maxFailureFee: profile.maxFailureFee, computeAmount: profile.computeAmount };
  const value = { ...withTrees, profiles: { linear_regression: reordered, logistic_regression: reordered, gradient_boosted_trees: profile } };
  const result = updateRunnerBillingPolicy(directory, json(value), testnet);
  assert.deepEqual([result.status, result.changedProfiles, result.addedProfiles], ["updated", [], ["gradient_boosted_trees"]]);
});

test("rejouer exactement le tarif installé répond « déjà appliqué » sans rien réécrire", async (t) => {
  const { billing, withTrees, directory } = installedVolume(t);
  updateRunnerBillingPolicy(directory, json(withTrees), testnet, { now: 1_000 });
  const files = readdirSync(directory).sort();
  const replay = updateRunnerBillingPolicy(directory, json(withTrees), testnet, { now: 2_000 });
  assert.deepEqual([replay.status, replay.backup, replay.sha256], ["already-applied", null, createHash("sha256").update(json(withTrees)).digest("hex")]);
  assert.deepEqual(readdirSync(directory).sort(), files, "aucune sauvegarde ni fichier préparé de plus");
  // Mêmes champs, octets différents : vraie modification, la même version reste refusée.
  assert.throws(() => updateRunnerBillingPolicy(directory, JSON.stringify(withTrees, null, 1), testnet), /Nouvelle version/);
  // Commande rejouée par `demo-renewal` ou un redémarrage de la CVM : sortie 0.
  const env = { PATH: process.env.PATH, NODE_ENV: "production" as const, RUNNER_VOLUME_ACTION: "update-billing-policy", EVM_NETWORK: "testnet",
    SIRIUS_USDC_ADDRESS: billing.usdc, SIRIUS_COMPUTE_RECIPIENT: billing.computeRecipient, RUNNER_UPDATED_BILLING_POLICY: json(withTrees) };
  const result = await promisify(execFile)(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/update-runner-billing-policy.ts", directory], { env, timeout: 10000 });
  assert.match(result.stdout, /déjà appliqué/);
  assert.deepEqual(readdirSync(directory).sort(), files);
});

test("un fichier préparé par une tentative interrompue ne bloque pas la relance", (t) => {
  const { withTrees, directory } = installedVolume(t);
  writeFileSync(join(directory, "billing-policy.json.next"), "{interrompu", { mode: 0o600 });
  updateRunnerBillingPolicy(directory, json(withTrees), testnet);
  assert.deepEqual(read(directory), withTrees);
  assert.ok(!readdirSync(directory).includes("billing-policy.json.next"));
});

test("la validité est bornée par le registre budgétaire réel, pas par la copie d'installation", (t) => {
  const { budget, withTrees, directory } = installedVolume(t, true);
  const later = budget.validUntil + 86_400_000;
  assert.throws(() => updateRunnerBillingPolicy(directory, json({ ...withTrees, validUntil: later }), testnet), /survivre/);
  renewSponsoredBudgetPolicy(join(directory, "ledger.sqlite"), budget.chainId, budget.wallet, { validUntil: later, observedAtMs: Date.now() }, "test");
  updateRunnerBillingPolicy(directory, json({ ...withTrees, validUntil: later }), testnet);
  assert.equal(read(directory).validUntil, later);
  assert.equal(JSON.parse(readFileSync(join(directory, "budget-policy.json"), "utf8")).validUntil, budget.validUntil, "copie d'installation non relue");
});

test("un volume sans tarif installé n'est jamais initialisé par la mise à jour", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sirius-billing-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { withTrees } = installedVolume(t);
  assert.throws(() => updateRunnerBillingPolicy(root, json(withTrees), testnet));
  assert.deepEqual(readdirSync(root), []);
});

test("la commande exige son action explicite et les comptes de la cible", async (t) => {
  const { billing, withTrees, directory } = installedVolume(t);
  const env = { PATH: process.env.PATH, NODE_ENV: "production" as const, RUNNER_VOLUME_ACTION: "update-billing-policy", EVM_NETWORK: "testnet",
    SIRIUS_USDC_ADDRESS: billing.usdc, SIRIUS_COMPUTE_RECIPIENT: billing.computeRecipient, RUNNER_UPDATED_BILLING_POLICY: json(withTrees) };
  const args = ["--conditions=react-server", "--import", "tsx", "scripts/update-runner-billing-policy.ts", directory];
  const execute = promisify(execFile);
  for (const change of [{ RUNNER_VOLUME_ACTION: "initialize-new-v7-volume" }, { SIRIUS_COMPUTE_RECIPIENT: `0x${"57".repeat(20)}` }, { EVM_NETWORK: "mainnet" }]) {
    await assert.rejects(execute(process.execPath, args, { env: { ...env, ...change }, timeout: 10000 }), { code: 1 });
  }
  assert.deepEqual(read(directory), billing);
  const result = await execute(process.execPath, args, { env, timeout: 10000 });
  assert.match(result.stdout, /profils ajoutés : gradient_boosted_trees/);
  assert.match(result.stdout, new RegExp(createHash("sha256").update(json(withTrees)).digest("hex")));
  assert.deepEqual(read(directory), withTrees);
});
