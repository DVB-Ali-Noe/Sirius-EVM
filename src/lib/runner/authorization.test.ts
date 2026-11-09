import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { before, test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { useWalletStore } from "@/stores/wallet";
import { activateRunnerDelegation, beginRunnerDelegation, issueRunnerGrant } from "./authorization-client";
import { buildDelegationMessage, encodeRunnerGrantHeader, parseRunnerGrantHeader } from "./authorization-contract";
import { verifyRunnerGrant } from "./authorization";
import { issueDatasetReceipt, verifyDatasetReceipt } from "./receipt";
import type { DatasetRef } from "@/lib/tee/contract";
import { deriveKey, getMasterKey } from "@/lib/crypto/encryption";

before(() => {
  process.env.TEE_MODE = "stub";
  process.env.SIRIUS_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.EVM_NETWORK = "testnet";
  process.env.SIRIUS_APP_ORIGIN = "http://localhost:3000";
});

async function signedGrant(demoSessionRevision?: number) {
  const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f094538b2927f5fc5a8c7e1b3e49b920e33e9f8a");
  useWalletStore.getState().setConnected(account.address, "testnet", "external");
  const sessionPublicKey = await beginRunnerDelegation();
  const now = Date.now();
  const message = buildDelegationMessage({
    origin: "http://localhost:3000",
    address: account.address,
    sessionPublicKey,
    network: "testnet",
    issuedAt: now,
    expiresAt: now + 60_000,
    challengeToken: "challenge.signature",
  });
  await activateRunnerDelegation({ message, walletSignature: await account.signMessage({ message }), sessionPublicKey });
  const intentParts = ["dataset-1", "job-1", "receipt-1"];
  return {
    address: account.address.toLowerCase(),
    intentParts,
    grant: await issueRunnerGrant("run-training", { datasetId: "dataset-1", jobId: "job-1", ...(demoSessionRevision === undefined ? {} : { demoSessionRevision }) }, intentParts),
  };
}

test("le runner vérifie la délégation EIP-191 et consomme le grant", async () => {
  const { address, grant, intentParts } = await signedGrant();
  assert.deepEqual(parseRunnerGrantHeader(encodeRunnerGrantHeader(grant)), grant);
  const expected = { operation: "run-training" as const, datasetId: "dataset-1", jobId: "job-1", intentParts };
  assert.equal((await verifyRunnerGrant(grant, expected)).subject, address);
  await assert.rejects(verifyRunnerGrant(grant, expected), /déjà utilisé/);
});

test("la révision Phala est signée et un grant d’une ancienne session ne traverse pas la réouverture", async () => {
  const { grant, intentParts } = await signedGrant(3);
  const expected = { operation: "run-training" as const, datasetId: "dataset-1", jobId: "job-1", intentParts, demoSessionRevision: 5 };
  await assert.rejects(verifyRunnerGrant(grant, expected), /hors scope/);
  grant.payload.demoSessionRevision = 5;
  await assert.rejects(verifyRunnerGrant(grant, expected), /Signature/);
});

test("un grant ne peut pas être élargi à un autre dataset", async () => {
  const { grant, intentParts } = await signedGrant();
  await assert.rejects(
    verifyRunnerGrant(grant, { operation: "run-training", datasetId: "dataset-2", jobId: "job-1", intentParts }),
    /hors scope/,
  );
});

test("le reçu de dataset lie les termes USDC au contenu scellé", () => {
  const dataset = {
    datasetId: "dataset-1",
    cid: "bafy-dataset",
    wrappedKey: "wrapped-key",
    merkleRoot: "0xabc123",
    priceUsdcAtomic: "2500000",
    challengeDays: 7,
    maxRentalDays: 90,
    modelId: "linear_regression",
    modelVersion: "1.0.0",
  } as const satisfies DatasetRef;
  const receipt = issueDatasetReceipt("0x1111111111111111111111111111111111111111", dataset);
  assert.equal(verifyDatasetReceipt(receipt, dataset).priceUsdcAtomic, "2500000");
  assert.equal(verifyDatasetReceipt(receipt, dataset).maxRentalDays, 90);
  assert.equal(verifyDatasetReceipt(receipt, dataset).version, 4);
  assert.throws(() => verifyDatasetReceipt(receipt, { ...dataset, priceUsdcAtomic: "1" }), /hors scope/);
  assert.throws(() => verifyDatasetReceipt(receipt, { ...dataset, maxRentalDays: 365 }), /hors scope/);
  assert.throws(() => verifyDatasetReceipt(receipt, { ...dataset, modelId: "logistic_regression" }), /hors scope/);
});

/** Reçu signé avec la clé du runner, tel qu'émis avant D-29 (v3) ou forgé hors format. */
function signedReceipt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", deriveKey(getMasterKey(), "runner-receipt:hmac:v3")).update(body).digest("base64url")}`;
}

test("un reçu de dataset v3 (avant D-29) reste accepté et vaut 30 jours de location maximum", () => {
  const dataset = {
    datasetId: "dataset-legacy", cid: "bafy-legacy", wrappedKey: "wrapped-legacy", merkleRoot: "0xdef456",
    priceUsdcAtomic: "1000000", challengeDays: 3, maxRentalDays: 30, modelId: "linear_regression", modelVersion: "1.0.0",
  } as const satisfies DatasetRef;
  const receiptPayload = {
    version: 3, kind: "dataset", datasetId: dataset.datasetId, owner: "0x1111111111111111111111111111111111111111",
    cid: dataset.cid, wrappedKeyHash: createHash("sha256").update(dataset.wrappedKey).digest("hex"),
    merkleRoot: dataset.merkleRoot, priceUsdcAtomic: dataset.priceUsdcAtomic, challengeDays: dataset.challengeDays,
    modelId: dataset.modelId, modelVersion: dataset.modelVersion,
  };
  const legacy = signedReceipt(receiptPayload);
  assert.equal(verifyDatasetReceipt(legacy, dataset).maxRentalDays, 30);
  assert.throws(() => verifyDatasetReceipt(legacy, { ...dataset, maxRentalDays: 31 }), /hors scope/);
  // Un v3 portant une durée, ou un v4 sans durée valide, n'existe pas : refusé.
  assert.throws(() => verifyDatasetReceipt(signedReceipt({ ...receiptPayload, maxRentalDays: 30 }), dataset), /Reçu runner invalide/);
  for (const maxRentalDays of [undefined, 0, 366, 1.5, "30"]) {
    assert.throws(() => verifyDatasetReceipt(signedReceipt({ ...receiptPayload, version: 4, maxRentalDays }), dataset), /Reçu runner invalide/);
  }
});
