import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { PublicClient, Hex } from "viem";
import { assertCanonicalReceipt, finalityPolicy } from "./finality";

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

test("les confirmations refusent une réorganisation et une profondeur insuffisante", async () => {
  process.env.SIRIUS_EVM_FINALITY = "confirmations";
  process.env.SIRIUS_EVM_CONFIRMATIONS = "2";
  process.env.EVM_NETWORK = "testnet";
  const hash = `0x${"12".repeat(32)}` as Hex;
  let tip = BigInt(11);
  let canonical = hash;
  const client = {
    getBlockNumber: async () => tip,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: canonical }),
  } as unknown as PublicClient;
  const receipt = { blockNumber: BigInt(10), blockHash: hash };
  await assertCanonicalReceipt(client, receipt);
  tip = BigInt(10);
  await assert.rejects(assertCanonicalReceipt(client, receipt), /non confirmée/);
  tip = BigInt(12);
  canonical = `0x${"34".repeat(32)}`;
  await assert.rejects(assertCanonicalReceipt(client, receipt), /réorganisée/);
});

test("la finalité stricte attend le bloc finalized et ne se replie pas sur latest", async () => {
  process.env.SIRIUS_EVM_FINALITY = "finalized";
  const hash = `0x${"12".repeat(32)}` as Hex;
  let finalized = BigInt(9);
  let unavailable = false;
  const client = {
    getBlockNumber: async () => BigInt(100),
    getBlock: async ({ blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string }) => {
      if (blockTag === "finalized" && unavailable) throw new Error("finalized indisponible");
      return { number: blockNumber ?? finalized, hash };
    },
  } as unknown as PublicClient;
  const receipt = { blockNumber: BigInt(10), blockHash: hash };
  await assert.rejects(assertCanonicalReceipt(client, receipt), /non confirmée/);
  finalized = BigInt(10);
  await assertCanonicalReceipt(client, receipt);
  unavailable = true;
  await assert.rejects(assertCanonicalReceipt(client, receipt), /indisponible/);
  process.env.EVM_NETWORK = "mainnet";
  process.env.SIRIUS_EVM_FINALITY = "confirmations";
  assert.throws(() => finalityPolicy(), /invalide/);
});
