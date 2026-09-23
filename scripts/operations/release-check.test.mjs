import assert from "node:assert/strict";
import { test } from "node:test";
import { checkReleaseEnvironments } from "./release-check.mjs";

function environments() {
  const common = { EVM_NETWORK: "testnet", SIRIUS_BILLING_VERSION: "7", SIRIUS_EVM_FINALITY: "finalized",
    SIRIUS_EVM_CONFIRMATIONS: "2", TEE_MODE: "phala", SIRIUS_LOCK_AUTHORIZER: `0x${"11".repeat(20)}`,
    RUNNER_TRANSPORT_SECRET: "synthetic".repeat(8) };
  for (const [index, suffix] of ["ESCROW", "DATASET", "KYB", "USDC"].entries()) common[`SIRIUS_${suffix}_ADDRESS`] = `0x${String(index + 2).repeat(40)}`;
  const client = { ...common, SIRIUS_REQUIRE_PHALA: "true", RUNNER_URL: "https://runner.example",
    DATABASE_URL: "postgresql://test:synthetic@db.example/test", SIRIUS_EXPECTED_MRTD: "11".repeat(48),
    SIRIUS_EXPECTED_RTMR3: "22".repeat(48), SIRIUS_EXPECTED_COMPOSE_HASH: "33".repeat(32),
    SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256: "44".repeat(32), NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256: "55".repeat(32) };
  const next = { ...client, NEXT_PUBLIC_EVM_NETWORK: "testnet" };
  for (const suffix of ["ESCROW", "DATASET", "KYB", "USDC"]) next[`NEXT_PUBLIC_SIRIUS_${suffix}_ADDRESS`] = common[`SIRIUS_${suffix}_ADDRESS`];
  return [next, { ...client }, { ...common, RUNNER_BUDGET_FILE: "/budget.sqlite", RUNNER_BILLING_POLICY_FILE: "/billing.json" }];
}
test("le préflight refuse les divergences de contrat, de finalité et de secrets sans les afficher", () => {
  const env = environments();
  assert.equal(checkReleaseEnvironments(...env).configurationReady, true);
  env[1].SIRIUS_ESCROW_ADDRESS = `0x${"ab".repeat(20)}`;
  env[1].SIRIUS_EVM_FINALITY = "confirmations";
  env[1].RUNNER_TRANSPORT_SECRET = "SECRET_NE_PAS_AFFICHER";
  const result = checkReleaseEnvironments(...env);
  assert.equal(result.configurationReady, false);
  assert.ok(result.issues.includes("divergence.SIRIUS_ESCROW_ADDRESS"));
  assert.ok(result.issues.includes("divergence.SIRIUS_EVM_FINALITY"));
  assert.ok(!JSON.stringify(result).includes(env[1].RUNNER_TRANSPORT_SECRET));
});
test("les clés de déploiement et les master keys n’entrent dans aucun service actif", () => {
  const env = environments();
  env[2].ROBINHOOD_DEPLOYER_KEY = "synthetic";
  env[0].SIRIUS_MASTER_KEY = "synthetic";
  assert.equal(checkReleaseEnvironments(...env).configurationReady, false);
});
