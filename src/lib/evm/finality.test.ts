import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { PublicClient, Hex } from "viem";
import { assertBlockStable, assertCanonicalReceipt, checkRpcFinality, finalityPolicy, lockFinalityStatus } from "./finality";

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


test("le préflight vérifie réseau, vue canonique et reçu sans envoyer de transaction", async () => {
  process.env.SIRIUS_EVM_FINALITY = "finalized";
  process.env.SIRIUS_EVM_CONFIRMATIONS = "2";
  process.env.EVM_NETWORK = "testnet";
  const hash = `0x${"12".repeat(32)}` as Hex;
  let chainId = 46630;
  let receiptHash = hash;
  let canonical = hash;
  const client = {
    getChainId: async () => chainId,
    getBlockNumber: async () => BigInt(15),
    getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => ({ number: blockNumber ?? BigInt(10), hash: blockNumber ? canonical : hash }),
    getTransactionReceipt: async () => ({ transactionHash: receiptHash, blockNumber: BigInt(10), blockHash: hash, status: "success" }),
  } as unknown as PublicClient;
  assert.deepEqual(await checkRpcFinality(client, 46630, hash), { chainId: 46630, policy: { confirmations: 2, finalized: true },
    latestBlock: "15", confirmedBlock: "10", confirmedHash: hash, lagBlocks: "5", transactionHash: hash, receiptStatus: "success" });
  chainId = 4663;
  await assert.rejects(checkRpcFinality(client, 46630), /autre réseau/);
  chainId = 46630;
  canonical = `0x${"34".repeat(32)}`;
  await assert.rejects(checkRpcFinality(client, 46630), /incohérente/);
  canonical = hash;
  receiptHash = `0x${"56".repeat(32)}`;
  await assert.rejects(checkRpcFinality(client, 46630, hash), /hors scope/);
  assert.throws(() => finalityPolicy(101), /invalide/);
});

test("le préflight refuse finalized absent ou non canonique sans dégrader sa politique", async () => {
  process.env.SIRIUS_EVM_FINALITY = "finalized";
  let missing = true;
  const client = { getChainId: async () => 46630, getBlockNumber: async () => BigInt(10),
    getBlock: async () => {
      if (missing) throw new Error("tag finalized indisponible");
      return { number: null, hash: null };
    } } as unknown as PublicClient;
  await assert.rejects(checkRpcFinality(client, 46630), /finalized indisponible/);
  missing = false;
  await assert.rejects(checkRpcFinality(client, 46630), /Finalité EVM indisponible/);
});

test("l'état de finalité d'un lock suit la même profondeur stable qu'assertBlockStable, avec une estimation", async () => {
  process.env.SIRIUS_EVM_FINALITY = "finalized";
  const hash = `0x${"12".repeat(32)}` as Hex;
  const now = Date.UTC(2026, 9, 7, 10, 0, 0);
  let finalized = BigInt(500);
  // Le bloc finalisé est horodaté 14 minutes avant le lock (bloc 9 000).
  const timestamps: Record<string, bigint> = { "500": BigInt(1_000), "9000": BigInt(1_000 + 14 * 60), "9500": BigInt(1_000 + 15 * 60) };
  const lockReads: bigint[] = [];
  const client = {
    getBlockNumber: async () => BigInt(10_000),
    getBlock: async ({ blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string }) => {
      const number = blockTag === "finalized" ? finalized : blockNumber!;
      if (blockNumber !== undefined) lockReads.push(blockNumber);
      return { number, hash, timestamp: timestamps[String(number)] };
    },
  } as unknown as PublicClient;
  assert.deepEqual(await lockFinalityStatus(client, BigInt(9_000), now), { pending: true, remainingMs: 14 * 60_000, estimatedReadyAt: now + 14 * 60_000 });
  await assert.rejects(assertBlockStable(client, BigInt(9_000), "en attente"), /en attente/);
  finalized = BigInt(9_500);
  assert.deepEqual(await lockFinalityStatus(client, BigInt(9_000), now), { pending: false, remainingMs: 0, estimatedReadyAt: now });
  await assertBlockStable(client, BigInt(9_000), "en attente");
  // L'horodatage du bloc de lock, immuable, n'est lu qu'une fois : chaque relecture coûte la tête et le bloc finalisé.
  assert.deepEqual(lockReads, [BigInt(9_000)]);
});
