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

function mainnetEnvironments() {
  const [next, reaper, runner] = environments();
  const usdc = "0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8";
  for (const env of [next, reaper, runner]) { env.EVM_NETWORK = "mainnet"; env.SIRIUS_USDC_ADDRESS = usdc; }
  Object.assign(next, { NEXT_PUBLIC_EVM_NETWORK: "mainnet", NEXT_PUBLIC_SIRIUS_USDC_ADDRESS: usdc,
    SIRIUS_MAX_LOAN_USDC: "50", SIRIUS_MAX_EXPOSURE_USDC: "500", NEXT_PUBLIC_WEB3AUTH_NETWORK: "sapphire_mainnet" });
  return [next, reaper, runner];
}

test("une configuration mainnet complète passe, et une configuration testnet est refusée en mode mainnet", () => {
  assert.equal(checkReleaseEnvironments(...mainnetEnvironments(), "mainnet").configurationReady, true);
  const testnet = checkReleaseEnvironments(...environments(), "mainnet");
  assert.equal(testnet.configurationReady, false);
  assert.ok(testnet.issues.includes("next.EVM_NETWORK"));
  assert.equal(checkReleaseEnvironments(...mainnetEnvironments()).configurationReady, false);
});

test("le mode mainnet refuse l'USDC de test, la démo, le faucet, le KYB ouvert et les plafonds absents", () => {
  const cases = [
    [(env) => { env[2].SIRIUS_USDC_ADDRESS = `0x${"5".repeat(40)}`; }, "runner.SIRIUS_USDC_ADDRESS.mainnet"],
    [(env) => { env[0].SIRIUS_DEPLOYMENT_MODE = "demo"; }, "next.demo-mode"],
    [(env) => { env[0].SIRIUS_FAUCET_KEY = "x"; }, "next.faucet-key"],
    [(env) => { env[1].SIRIUS_KYB_MODE = "open"; }, "reaper.SIRIUS_KYB_MODE.open"],
    [(env) => { delete env[0].SIRIUS_MAX_EXPOSURE_USDC; }, "next.SIRIUS_MAX_EXPOSURE_USDC"],
    [(env) => { env[0].SIRIUS_LEGACY_ESCROW_ADDRESSES = `0x${"9".repeat(40)}`; }, "next.SIRIUS_LEGACY_ESCROW_ADDRESSES.inherited"],
    [(env) => { env[0].NEXT_PUBLIC_WEB3AUTH_NETWORK = "sapphire_devnet"; }, "next.NEXT_PUBLIC_WEB3AUTH_NETWORK"],
  ];
  for (const [change, issue] of cases) {
    const env = mainnetEnvironments();
    change(env);
    assert.ok(checkReleaseEnvironments(...env, "mainnet").issues.includes(issue), issue);
  }
});
