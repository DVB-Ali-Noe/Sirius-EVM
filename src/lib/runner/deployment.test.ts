import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { getPublicClient } from "@/lib/evm/client";
import { verifyRunnerDeployment } from "./deployment";

const escrow = `0x${"11".repeat(20)}`;
const datasets = `0x${"22".repeat(20)}`;
const kyb = `0x${"33".repeat(20)}`;
const usdc = `0x${"44".repeat(20)}`;
const signer = `0x${"55".repeat(20)}`;
const other = `0x${"66".repeat(20)}`;
const saved = { ...process.env };
let chainId: number;
let bindings: Record<string, string>;

beforeEach(() => {
  Object.assign(process.env, {
    EVM_NETWORK: "testnet", EVM_RPC_URL: "https://rpc.test.invalid", SIRIUS_ESCROW_ADDRESS: escrow,
    SIRIUS_DATASET_ADDRESS: datasets, SIRIUS_KYB_ADDRESS: kyb, SIRIUS_USDC_ADDRESS: usdc, SIRIUS_LOCK_AUTHORIZER: signer,
  });
  chainId = 46630;
  bindings = { lockAuthorizer: signer, kyb, usdc, datasetKyb: kyb };
  mock.method(getPublicClient(), "getChainId", async () => chainId);
  mock.method(getPublicClient(), "readContract", async ({ address, functionName }: { address: string; functionName: string }) => {
    if (functionName === "VERSION") return address.toLowerCase() === escrow ? "sirius-escrow-usdc-v6" : "sirius-dataset-v4";
    if (functionName === "datasets") return datasets;
    if (functionName === "escrow") return escrow;
    if (functionName === "kyb" && address.toLowerCase() === datasets) return bindings.datasetKyb;
    return bindings[functionName];
  });
});
afterEach(() => {
  mock.restoreAll();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

test("l’activation exige le signataire dérivé et les contrats du même réseau", async () => {
  await verifyRunnerDeployment(signer);
  await assert.rejects(verifyRunnerDeployment(other), /identité/);
  delete process.env.SIRIUS_LOCK_AUTHORIZER;
  await assert.rejects(verifyRunnerDeployment(signer), /identité/);
});

for (const field of ["lockAuthorizer", "kyb", "usdc", "datasetKyb"]) {
  test(`l’activation refuse une divergence ${field}`, async () => {
    bindings[field] = other;
    await assert.rejects(verifyRunnerDeployment(signer), /réseau ou les contrats/);
  });
}

test("l’activation refuse un RPC d’un autre réseau", async () => {
  chainId = 4663;
  await assert.rejects(verifyRunnerDeployment(signer), /réseau ou les contrats/);
});
