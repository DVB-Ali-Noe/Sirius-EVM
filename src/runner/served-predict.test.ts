import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { keccak256, stringToHex, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { useWalletStore } from "@/stores/wallet";
import { activateRunnerDelegation, beginRunnerDelegation, issueRunnerGrant } from "@/lib/runner/authorization-client";
import { buildDelegationMessage } from "@/lib/runner/authorization-contract";
import { initializeBudgetLedger, type BudgetPolicy } from "@/lib/runner/budget-ledger";
import { runnerBudget } from "@/lib/runner/budget";
import { demoSessions } from "@/lib/phala-demo/runner-session";
import { generateKey, encrypt, wrapKey, primeMasterKey } from "@/lib/crypto/encryption";
import { buildMerkleTree } from "@/lib/crypto/merkle";
import { saveServedModel } from "@/lib/tee/served-models";
import { runServedTraining } from "@/lib/tee/core";
import type { GradientBoostedTreesModel } from "@/lib/models/registry";
import type { SignedPrediction } from "@/lib/tee/contract";
import { handleRunnerOp } from "./handler";

const model: GradientBoostedTreesModel = {
  algo: "gradient_boosted_trees", version: "1.1.0", target: "label", features: ["age"], baseScore: 0,
  trees: [{ feature: 0, threshold: 10, left: { value: -0.25 }, right: { value: 0.25 } }],
  metrics: { heldOutAuc: 0.7, heldOutAccuracy: 0.6, heldOutPrecision: 0.6,
    heldOutRecall: 0.5, heldOutF1: 0.55, aucGap: 0.05, n: 10_000 },
};

test("modèle servi sans livraison, prédiction binaire signée et grants liés aux variables", async () => {
  const root = mkdtempSync(join(tmpdir(), "sirius-served-predict-"));
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  const account = privateKeyToAccount(`0x${"59c6995e998f97a5a0044966f094538b2927f5fc5a8c7e1b3e49b920e33e9f8a"}`);
  const owner = account.address.toLowerCase();
  const origin = "https://demo.example";
  const policy: BudgetPolicy = {
    version: 1, chainId: 46630, wallet: owner, accountingReference: "synthetic-prediction",
    validUntil: Date.now() + 60_000, earnedMarginUsdMicros: "0", cashUsdMicros: "0", fixedReserveUsdMicros: "100",
    sponsored: { funding: "credits", creditsUsdMicros: "1000", cashUsdMicros: "0", ceilingUsdMicros: "900",
      maxOperations: 50, maxOperationsPerWallet: 50, maxConcurrent: 1, origin, observedAtMs: Date.now() - 1000 },
    costsUsdMicros: { request: "1", seal: "10", training: "50" },
    gas: { totalWei: "0", maxTransactionWei: "1", maxGas: "1", maxFeePerGasWei: "1", ethUsdMicrosUpperBound: "1", confirmations: 1 },
    maxFailures: 3, maxActive: 2,
  };
  Object.assign(process.env, {
    NODE_ENV: "test", EVM_NETWORK: "testnet", TEE_MODE: "phala", DSTACK_SIMULATOR_ENDPOINT: "",
    SIRIUS_BILLING_VERSION: "6", SIRIUS_PHALA_DEMO: "true", SIRIUS_PREDICT_ENABLED: "true",
    SIRIUS_APP_ORIGIN: origin, SIRIUS_LOCK_AUTHORIZER: owner, SIRIUS_ESCROW_ADDRESS: `0x${"34".repeat(20)}`,
    SIRIUS_MASTER_KEY: Buffer.alloc(32, 17).toString("base64"), RUNNER_BUDGET_FILE: join(root, "budget.sqlite"),
    RUNNER_DEMO_SESSION_FILE: join(root, "session.sqlite"), RUNNER_PREDICT_USAGE_FILE: join(root, "usage.sqlite"),
    PINATA_GATEWAY: "https://gateway.pinata.cloud",
    RUNNER_SERVED_MODELS_DIR: join(root, "models"), RUNNER_PREDICT_DAILY_LIMIT: "3",
  });
  delete process.env.RUNNER_REPLAY_DIR;
  primeMasterKey(Buffer.alloc(32, 17));
  initializeBudgetLedger(process.env.RUNNER_BUDGET_FILE!, policy);
  let sessionOpened = false;
  try {
    const session = demoSessions();
    session.command("open", 0, owner, policy.sponsored);
    sessionOpened = true;
    saveServedModel("job-1", owner, model);
    let attemptedUploads = 0;
    globalThis.fetch = async () => { attemptedUploads++; throw new Error("IPFS must not receive a served model"); };
    const retry = await runServedTraining({ jobId: "job-1", owner, datasetId: "dataset-1", cid: "not-fetched",
      wrappedKey: "not-delivered", merkleRoot: "not-fetched", priceUsdcAtomic: "1", challengeDays: 1,
      modelId: "gradient_boosted_trees", modelVersion: "1.1.0" });
    assert.deepEqual(retry, { servedModelId: "job-1", metrics: model.metrics });
    assert.equal(attemptedUploads, 0);
    assert.equal("modelCid" in retry || "modelKeyEnvelope" in retry || "runnerReceipt" in retry, false);
    const plaintext = readFileSync(join(process.cwd(), "public/examples/classification/credit-risk-train.csv"));
    const dek = generateKey();
    const dataset = { jobId: "job-2", owner, datasetId: "dataset-2", cid: "dataset-cid",
      wrappedKey: wrapKey(dek, "wrap:dataset:v1:dataset-2"), merkleRoot: buildMerkleTree(plaintext).root,
      priceUsdcAtomic: "1", challengeDays: 1, modelId: "gradient_boosted_trees" as const,
      modelVersion: "1.1.0" as const };
    const encryptedDataset = JSON.stringify(encrypt(plaintext, dek));
    let fetchedDataset = 0;
    globalThis.fetch = async (input, init) => {
      fetchedDataset++;
      assert.equal(String(input), "https://gateway.pinata.cloud/ipfs/dataset-cid");
      assert.equal(init?.method, undefined);
      return new Response(encryptedDataset, { status: 200 });
    };
    const trained = await runServedTraining(dataset);
    assert.equal(trained.servedModelId, "job-2");
    assert.equal("modelCid" in trained || "modelKeyEnvelope" in trained || "runnerReceipt" in trained, false);
    assert.equal(attemptedUploads, 0);
    const resumed = await runServedTraining(dataset);
    assert.deepEqual(resumed, trained);
    assert.equal(fetchedDataset, 1);
    unlinkSync(join(process.env.RUNNER_SERVED_MODELS_DIR!, `${createHash("sha256").update("job-2").digest("hex")}.enc`));
    await assert.rejects(runServedTraining(dataset), /Modèle privé indisponible/);

    useWalletStore.getState().setConnected(account.address, "testnet", "external");
    const sessionPublicKey = await beginRunnerDelegation();
    const now = Date.now();
    const message = buildDelegationMessage({ origin, address: account.address, sessionPublicKey,
      network: "testnet", issuedAt: now, expiresAt: now + 60_000, challengeToken: "challenge.signature" });
    await activateRunnerDelegation({ message, walletSignature: await account.signMessage({ message }), sessionPublicKey });
    const authorize = (features: Record<string, number>, jobId = "job-1") =>
      issueRunnerGrant("predict", { jobId, demoSessionRevision: 1 }, ["job-1", JSON.stringify(features)]);
    const features = { age: 12 };
    const grant = await authorize(features);
    const result = await handleRunnerOp("predict", { modelId: "job-1", features, authorization: grant }) as SignedPrediction;
    assert.equal(result.decision, 1);
    assert.equal(result.counter, 1);
    assert.equal("probability" in result || "score" in result, false);
    assert.equal(result.signedMessage.featuresHash, keccak256(stringToHex(JSON.stringify(features))));
    assert.equal(await verifyTypedData({ address: result.signer, domain: result.domain, primaryType: "Prediction",
      types: { Prediction: [
        { name: "modelId", type: "string" }, { name: "modelVersion", type: "string" },
        { name: "subject", type: "address" }, { name: "featuresHash", type: "bytes32" },
        { name: "decision", type: "uint8" }, { name: "counter", type: "uint64" },
        { name: "sessionRevision", type: "uint64" },
      ] }, message: { ...result.signedMessage, counter: BigInt(result.counter), sessionRevision: BigInt(result.signedMessage.sessionRevision) },
      signature: result.signature }), true);
    await assert.rejects(handleRunnerOp("predict", { modelId: "job-1", features, authorization: grant }), /déjà utilisé/);
    await assert.rejects(handleRunnerOp("predict", { modelId: "job-1", features, authorization: await authorize(features, "other") }), /hors scope/);
    await assert.rejects(handleRunnerOp("predict", { modelId: "job-1", features: { age: 12, leak: 1 },
      authorization: await authorize({ age: 12, leak: 1 }) }), /hors modèle/);
    await assert.rejects(handleRunnerOp("predict", { modelId: "job-1", features: { age: Number.POSITIVE_INFINITY } }), /invalides/);
    await assert.rejects(handleRunnerOp("predict", { modelId: "job-1", features: { age: 1e10 } }), /invalides/);
    const second = await handleRunnerOp("predict", { modelId: "job-1", features: { age: 5 },
      authorization: await authorize({ age: 5 }) }) as SignedPrediction;
    assert.equal(second.decision, 0);
    assert.equal(second.counter, 2);
    const stranger = privateKeyToAccount(`0x${"11".repeat(32)}`);
    useWalletStore.getState().setConnected(stranger.address, "testnet", "external");
    const strangerKey = await beginRunnerDelegation();
    const strangerMessage = buildDelegationMessage({ origin, address: stranger.address, sessionPublicKey: strangerKey,
      network: "testnet", issuedAt: now, expiresAt: now + 60_000, challengeToken: "challenge.signature" });
    await activateRunnerDelegation({ message: strangerMessage,
      walletSignature: await stranger.signMessage({ message: strangerMessage }), sessionPublicKey: strangerKey });
    await assert.rejects(handleRunnerOp("predict", { modelId: "job-1", features,
      authorization: await issueRunnerGrant("predict", { jobId: "job-1", demoSessionRevision: 1 },
        ["job-1", JSON.stringify(features)]) }), /réservée au propriétaire/);
    session.command("close", 1, owner);
    await assert.rejects(handleRunnerOp("predict", {}), /fermée/);
  } finally {
    globalThis.fetch = originalFetch;
    if (sessionOpened) demoSessions().close();
    try { runnerBudget()?.close(); } catch { /* conserve l'erreur initiale du scénario */ }
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});
