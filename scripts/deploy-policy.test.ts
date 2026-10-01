import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentPlan, MAINNET_CHAIN_ID, MAINNET_USDC, TESTNET_CHAIN_ID } from "./deploy-policy";

const deployer = `0x${"d1".repeat(20)}`;
const safe = `0x${"5a".repeat(20)}`;
const verifier = `0x${"7e".repeat(20)}`;
const enclave = `0x${"3b".repeat(20)}`;

function mainnetEnv(change: Record<string, string | undefined> = {}) {
  return {
    SIRIUS_ALLOW_MAINNET: "true", SIRIUS_BILLING_VERSION: "7", SIRIUS_USDC_ADDRESS: MAINNET_USDC,
    SIRIUS_KYB_ADMIN: safe, SIRIUS_KYB_VERIFIER: verifier, SIRIUS_LOCK_AUTHORIZER: enclave, ...change,
  };
}

test("un déploiement mainnet complet passe et exige que l’admin KYB soit un contrat", () => {
  const plan = deploymentPlan(mainnetEnv(), MAINNET_CHAIN_ID, deployer);
  assert.equal(plan.escrowContract, "SiriusEscrowV7");
  assert.equal(plan.kybOpen, false);
  assert.deepEqual(plan.mustBeContracts, [safe]);
  assert.equal(plan.dryRun, false);
  assert.equal(deploymentPlan(mainnetEnv({ SIRIUS_DEPLOY_DRY_RUN: "true" }), MAINNET_CHAIN_ID, deployer).dryRun, true);
});

test("mainnet refuse la v6 implicite ou explicite et l’absence d’autorisation", () => {
  assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_BILLING_VERSION: undefined }), MAINNET_CHAIN_ID, deployer), /BILLING_VERSION=7/);
  assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_BILLING_VERSION: "6" }), MAINNET_CHAIN_ID, deployer), /BILLING_VERSION=7/);
  assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_ALLOW_MAINNET: undefined }), MAINNET_CHAIN_ID, deployer), /bloqué/);
});

test("mainnet refuse les raccourcis de testnet", () => {
  assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_ALLOW_SHARED_ROLES: "true" }), MAINNET_CHAIN_ID, deployer), /interdit hors testnet/);
  assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_KYB_MODE: "open" }), MAINNET_CHAIN_ID, deployer), /réservé au testnet/);
  assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_USDC_ADDRESS: `0x${"34".repeat(20)}` }), MAINNET_CHAIN_ID, deployer), /USDC natif/);
  assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_KYB_ADMIN: undefined }), MAINNET_CHAIN_ID, deployer), /KYB_ADMIN/);
  assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_LOCK_AUTHORIZER: `0x${"0".repeat(40)}` }), MAINNET_CHAIN_ID, deployer), /non nulle/);
});

test("mainnet exige quatre adresses distinctes, casse ignorée", () => {
  for (const change of [
    { SIRIUS_KYB_ADMIN: deployer }, { SIRIUS_KYB_VERIFIER: deployer }, { SIRIUS_LOCK_AUTHORIZER: deployer },
    { SIRIUS_KYB_VERIFIER: safe }, { SIRIUS_LOCK_AUTHORIZER: verifier.toUpperCase().replace("0X", "0x") },
  ]) {
    assert.throws(() => deploymentPlan(mainnetEnv(change), MAINNET_CHAIN_ID, deployer), /quatre adresses distinctes/, JSON.stringify(change));
  }
});

test("le testnet garde ses raccourcis assumés", () => {
  const base = { SIRIUS_USDC_ADDRESS: `0x${"34".repeat(20)}`, SIRIUS_LOCK_AUTHORIZER: enclave };
  assert.equal(deploymentPlan({ ...base, SIRIUS_KYB_MODE: "open" }, TESTNET_CHAIN_ID, deployer).kybOpen, true);
  assert.equal(deploymentPlan({ ...base, SIRIUS_ALLOW_SHARED_ROLES: "true" }, TESTNET_CHAIN_ID, deployer).sharedRoles, true);
  assert.equal(deploymentPlan({ ...base, SIRIUS_KYB_ADMIN: safe, SIRIUS_KYB_VERIFIER: verifier }, TESTNET_CHAIN_ID, deployer).escrowContract, "SiriusEscrow");
  assert.throws(() => deploymentPlan(base, TESTNET_CHAIN_ID, deployer), /requis/);
  assert.throws(() => deploymentPlan({ ...base, SIRIUS_KYB_ADMIN: safe, SIRIUS_KYB_VERIFIER: safe }, TESTNET_CHAIN_ID, deployer), /distinctes/);
  assert.throws(() => deploymentPlan(base, 1, deployer), /Réseau inattendu/);
});
