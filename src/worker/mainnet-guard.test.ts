import assert from "node:assert/strict";
import { test } from "node:test";
import { assertReaperMainnetConfiguration, reaperMainnetIssues } from "./mainnet-guard";

const complete = {
  EVM_NETWORK: "mainnet", TEE_MODE: "phala", SIRIUS_REQUIRE_PHALA: "true", SIRIUS_BILLING_VERSION: "7",
  SIRIUS_EVM_FINALITY: "finalized", EVM_RPC_URL: "https://rpc", RUNNER_URL: "https://runner", RUNNER_TRANSPORT_SECRET: "s",
  SIRIUS_LOCK_AUTHORIZER: "0x1", SIRIUS_USDC_ADDRESS: "0x2", SIRIUS_KYB_ADDRESS: "0x3", SIRIUS_EXPECTED_MRTD: "a",
  SIRIUS_EXPECTED_RTMR3: "b", SIRIUS_EXPECTED_COMPOSE_HASH: "c", SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256: "d",
  NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256: "e",
};

test("le testnet garde ses valeurs historiques", () => {
  assert.deepEqual(reaperMainnetIssues({ EVM_NETWORK: "testnet", TEE_MODE: "stub" }), []);
  assert.deepEqual(reaperMainnetIssues({}), []);
});

test("une configuration mainnet complète démarre", () => {
  assert.doesNotThrow(() => assertReaperMainnetConfiguration(complete));
});

test("les valeurs de démonstration et les oublis bloquent le démarrage sur mainnet", () => {
  assert.throws(() => assertReaperMainnetConfiguration({ ...complete, TEE_MODE: "stub" }), /TEE_MODE=phala/);
  assert.throws(() => assertReaperMainnetConfiguration({ ...complete, SIRIUS_BILLING_VERSION: "6" }), /SIRIUS_BILLING_VERSION=7/);
  assert.throws(() => assertReaperMainnetConfiguration({ ...complete, SIRIUS_REQUIRE_PHALA: "false" }), /SIRIUS_REQUIRE_PHALA/);
  assert.throws(() => assertReaperMainnetConfiguration({ ...complete, RUNNER_URL: "" }), /RUNNER_URL/);
  assert.throws(() => assertReaperMainnetConfiguration({ ...complete, SIRIUS_LEGACY_ESCROW_ADDRESSES: "0xabc" }), /LEGACY/);
});
