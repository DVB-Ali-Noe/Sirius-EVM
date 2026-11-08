import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { billingPolicy } from "./config";

const profile = { computeAmount: "3000000", maxFailureFee: "1000000", executionRateAtomicPerMs: "100", maxExecutionMs: 15000 };
const policy = (computeAmount = "3000000") => ({
  version: 1, tariffVersion: "test-v1", costReference: "synthetic", validUntil: Date.now() + 86_400_000,
  chainId: 46630, usdc: `0x${"34".repeat(20)}`, usdcDecimals: 6, computeRecipient: `0x${"56".repeat(20)}`,
  minimumComputeAmount: "1000000", noTrainingComputeAmount: "100000",
  apiCallsPerDay: { logistic_regression: 50, gradient_boosted_trees: 100 },
  profiles: { linear_regression: { ...profile, computeAmount }, logistic_regression: profile },
});

test("le tarif se lit dans la variable JSON quand aucun fichier n'est configuré", () => {
  const loaded = billingPolicy({ SIRIUS_BILLING_POLICY_JSON: JSON.stringify(policy()) });
  assert.equal(loaded.profiles.linear_regression.computeAmount, "3000000");
});

test("le fichier du runner garde la priorité sur la variable", () => {
  const dir = mkdtempSync(join(tmpdir(), "sirius-tarif-"));
  try {
    const file = join(dir, "billing.json");
    writeFileSync(file, JSON.stringify(policy("5000000")));
    const loaded = billingPolicy({ RUNNER_BILLING_POLICY_FILE: file, SIRIUS_BILLING_POLICY_JSON: JSON.stringify(policy()) });
    assert.equal(loaded.profiles.linear_regression.computeAmount, "5000000");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("un tarif absent, invalide, périmé ou trop volumineux est refusé", () => {
  assert.throws(() => billingPolicy({}), /Tarif compute/);
  assert.throws(() => billingPolicy({ SIRIUS_BILLING_POLICY_JSON: "{" }), /Tarif compute/);
  assert.throws(() => billingPolicy({ SIRIUS_BILLING_POLICY_JSON: JSON.stringify({ ...policy(), validUntil: Date.now() - 1 }) }), /Tarif compute/);
  assert.throws(() => billingPolicy({ SIRIUS_BILLING_POLICY_JSON: JSON.stringify(policy()) + " ".repeat(16_384) }), /Tarif compute/);
});

test("une politique installée avant le profil arbres reste valide ; un profil arbres présent doit être complet", () => {
  const installed = billingPolicy({ SIRIUS_BILLING_POLICY_JSON: JSON.stringify(policy()) });
  assert.equal(installed.profiles.gradient_boosted_trees, undefined);
  const priced = { ...policy(), profiles: { ...policy().profiles, gradient_boosted_trees: profile } };
  assert.equal(billingPolicy({ SIRIUS_BILLING_POLICY_JSON: JSON.stringify(priced) }).profiles.gradient_boosted_trees?.computeAmount, "3000000");
  for (const broken of [{ ...profile, maxExecutionMs: 30_001 }, { ...profile, computeAmount: "1e6" }]) {
    const invalid = { ...policy(), profiles: { ...policy().profiles, gradient_boosted_trees: broken } };
    assert.throws(() => billingPolicy({ SIRIUS_BILLING_POLICY_JSON: JSON.stringify(invalid) }), /Tarif compute/);
  }
  const withoutLogistic = { ...policy(), profiles: { linear_regression: profile } };
  assert.throws(() => billingPolicy({ SIRIUS_BILLING_POLICY_JSON: JSON.stringify(withoutLogistic) }), /Tarif compute/);
});

test("frais sans entraînement et quotas d'API sont obligatoires et bornés ; jamais pour la régression linéaire", () => {
  const loaded = billingPolicy({ SIRIUS_BILLING_POLICY_JSON: JSON.stringify(policy()) });
  assert.equal(loaded.noTrainingComputeAmount, "100000");
  assert.deepEqual(loaded.apiCallsPerDay, { logistic_regression: 50, gradient_boosted_trees: 100 });
  assert.deepEqual(billingPolicy({ SIRIUS_BILLING_POLICY_JSON: JSON.stringify({ ...policy(), apiCallsPerDay: {} }) }).apiCallsPerDay, {},
    "aucun profil avec API : politique valide, ni API ni packs");
  for (const invalid of [
    // JSON.stringify omet une clé `undefined` : champ absent.
    { ...policy(), noTrainingComputeAmount: undefined }, { ...policy(), apiCallsPerDay: undefined },
    { ...policy(), noTrainingComputeAmount: "0" },
    { ...policy(), noTrainingComputeAmount: "1e5" },
    { ...policy(), noTrainingComputeAmount: 100000 },
    { ...policy(), apiCallsPerDay: [50] },
    { ...policy(), apiCallsPerDay: null },
    { ...policy(), apiCallsPerDay: { linear_regression: 10 } },
    { ...policy(), apiCallsPerDay: { logistic_regression: 0 } },
    { ...policy(), apiCallsPerDay: { logistic_regression: 10_001 } },
    { ...policy(), apiCallsPerDay: { logistic_regression: 1.5 } },
    { ...policy(), apiCallsPerDay: { logistic_regression: "50" } },
    { ...policy(), apiCallsPerDay: { unknown_model: 50 } },
  ]) {
    assert.throws(() => billingPolicy({ SIRIUS_BILLING_POLICY_JSON: JSON.stringify(invalid) }), /Tarif compute/, JSON.stringify(invalid).slice(-80));
  }
});

test("tarif journalier de l'accès API facultatif : absent, l'accès n'est pas en vente ; présent, strictement positif", () => {
  assert.equal(billingPolicy({ SIRIUS_BILLING_POLICY_JSON: JSON.stringify(policy()) }).apiAccessDailyComputeAmount, undefined);
  assert.equal(billingPolicy({ SIRIUS_BILLING_POLICY_JSON: JSON.stringify({ ...policy(), apiAccessDailyComputeAmount: "1500000" }) })
    .apiAccessDailyComputeAmount, "1500000");
  for (const fee of ["0", "1.5", 1500000, "", null]) {
    assert.throws(() => billingPolicy({ SIRIUS_BILLING_POLICY_JSON: JSON.stringify({ ...policy(), apiAccessDailyComputeAmount: fee }) }),
      /Tarif compute/, String(fee));
  }
});
