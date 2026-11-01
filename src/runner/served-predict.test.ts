import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encodeFunctionResult, keccak256, stringToHex, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { useWalletStore } from "@/stores/wallet";
import { activateRunnerDelegation, beginRunnerDelegation, issueRunnerGrant } from "@/lib/runner/authorization-client";
import { buildDelegationMessage } from "@/lib/runner/authorization-contract";
import { initializeBudgetLedger, type BudgetPolicy } from "@/lib/runner/budget-ledger";
import { runnerBudget } from "@/lib/runner/budget";
import { issueLoanReceipt } from "@/lib/runner/receipt";
import { demoSessions } from "@/lib/phala-demo/runner-session";
import { generateKey, encrypt, wrapKey, primeMasterKey } from "@/lib/crypto/encryption";
import { buildMerkleTree } from "@/lib/crypto/merkle";
import { robinhoodTestnet } from "@/lib/evm/networks";
import { siriusescrowAbi } from "@/lib/evm/abi/siriusescrow";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import { saveServedModel, servedModelFingerprint } from "@/lib/tee/served-models";
import { runSelfTraining } from "@/lib/tee/core";
import type { GradientBoostedTreesModel, LinearRegressionModel, LogisticRegressionModel } from "@/lib/models/registry";
import { PREDICTION_EIP712_TYPES, type SignedPrediction } from "@/lib/tee/contract";
import { handleRunnerOp } from "./handler";

const trees: GradientBoostedTreesModel = {
  algo: "gradient_boosted_trees", version: "1.1.0", target: "label", features: ["age"], baseScore: 0,
  trees: [{ feature: 0, threshold: 10, left: { value: -0.25 }, right: { value: 0.25 } }],
  metrics: { heldOutAuc: 0.7, heldOutAccuracy: 0.6, heldOutPrecision: 0.6,
    heldOutRecall: 0.5, heldOutF1: 0.55, aucGap: 0.05, n: 10_000 },
};
const linear: LinearRegressionModel = {
  algo: "linear_regression", version: "1.0.0", target: "price", features: ["size"], coefficients: [1, 2.34567],
  metrics: { r2: 0.9, rmse: 1, mae: 1, n: 100 },
};
const logistic: LogisticRegressionModel = {
  algo: "logistic_regression", version: "1.0.0", target: "default", features: ["x", "y"], coefficients: [-1, 0.5, 0],
  metrics: { accuracy: 0.7, precision: 0.7, recall: 0.7, f1: 0.7, n: 100 },
};

const RPC_URL = "http://rpc.test.invalid/";

test("modèles scellés sans livraison, prédictions signées par profil, prêts gardés par le règlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "sirius-served-predict-"));
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  const chainContracts = robinhoodTestnet.contracts;
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
    SIRIUS_BILLING_VERSION: "6", SIRIUS_PHALA_DEMO: "true", EVM_RPC_URL: RPC_URL,
    SIRIUS_APP_ORIGIN: origin, SIRIUS_LOCK_AUTHORIZER: owner, SIRIUS_ESCROW_ADDRESS: `0x${"34".repeat(20)}`,
    SIRIUS_MASTER_KEY: Buffer.alloc(32, 17).toString("base64"), RUNNER_BUDGET_FILE: join(root, "budget.sqlite"),
    RUNNER_DEMO_SESSION_FILE: join(root, "session.sqlite"), RUNNER_PREDICT_USAGE_FILE: join(root, "usage.sqlite"),
    PINATA_GATEWAY: "https://gateway.pinata.cloud",
    RUNNER_SERVED_MODELS_DIR: join(root, "models"), RUNNER_PREDICT_DAILY_LIMIT: "3",
  });
  delete process.env.RUNNER_REPLAY_DIR;
  // Sans Multicall3 déclaré, viem lit l'escrow par un eth_call simple, que le faux RPC décode.
  robinhoodTestnet.contracts = undefined;
  primeMasterKey(Buffer.alloc(32, 17));
  initializeBudgetLedger(process.env.RUNNER_BUDGET_FILE!, policy);
  let sessionOpened = false;
  try {
    const session = demoSessions();
    session.command("open", 0, owner, policy.sponsored);
    sessionOpened = true;

    // --- Entraînement : toujours scellé, jamais publié, repris sans recalcul. ---
    saveServedModel({ kind: "job", id: "job-1" }, owner, trees);
    let attemptedUploads = 0;
    globalThis.fetch = async () => { attemptedUploads++; throw new Error("IPFS must not receive a sealed model"); };
    const retry = await runSelfTraining({ jobId: "job-1", owner, datasetId: "dataset-1", cid: "not-fetched",
      wrappedKey: "not-delivered", merkleRoot: "not-fetched", priceUsdcAtomic: "1", challengeDays: 1,
      modelId: "gradient_boosted_trees", modelVersion: "1.1.0" });
    assert.deepEqual(retry, { servedModelId: "job-1", modelCid: servedModelFingerprint(trees), metrics: trees.metrics });
    assert.match(retry.modelCid, /^sm1[0-9a-f]{64}$/);
    assert.equal(attemptedUploads, 0);
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
    const trained = await runSelfTraining(dataset);
    assert.equal(trained.servedModelId, "job-2");
    assert.match(trained.modelCid, /^sm1[0-9a-f]{64}$/);
    assert.equal("modelKeyEnvelope" in trained, false);
    const resumed = await runSelfTraining(dataset);
    assert.deepEqual(resumed, trained);
    assert.equal(fetchedDataset, 1);
    unlinkSync(join(process.env.RUNNER_SERVED_MODELS_DIR!, `${createHash("sha256").update("job:job-2").digest("hex")}.enc`));
    await assert.rejects(runSelfTraining(dataset), /Modèle privé indisponible/);

    // --- Prédiction : un faux RPC publie (ou non) le préimage du prêt. ---
    let preimageRevealed = false;
    const preimage: Hex = `0x${"77".repeat(32)}`;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), RPC_URL, "aucun appel réseau hors RPC pendant une prédiction");
      const rpc = JSON.parse(String(init?.body)) as { id: number; method: string };
      assert.equal(rpc.method, "eth_call");
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: encodeFunctionResult({
        abi: siriusescrowAbi, functionName: "preimageOf",
        result: preimageRevealed ? [true, preimage] : [false, `0x${"00".repeat(32)}`],
      }) });
    };
    saveServedModel({ kind: "job", id: "job-lin" }, owner, linear);
    saveServedModel({ kind: "loan", id: "loan-1" }, owner, logistic);

    useWalletStore.getState().setConnected(account.address, "testnet", "external");
    const sessionPublicKey = await beginRunnerDelegation();
    const now = Date.now();
    const message = buildDelegationMessage({ origin, address: account.address, sessionPublicKey,
      network: "testnet", issuedAt: now, expiresAt: now + 60_000, challengeToken: "challenge.signature" });
    await activateRunnerDelegation({ message, walletSignature: await account.signMessage({ message }), sessionPublicKey });
    const grant = (kind: "job" | "loan", id: string, features: Record<string, number>, scopeId = id) =>
      issueRunnerGrant("predict", { ...(kind === "job" ? { jobId: scopeId } : { loanId: scopeId }), demoSessionRevision: 1 },
        [kind, id, JSON.stringify(features)]);
    const predictJob = async (id: string, features: Record<string, number>) =>
      handleRunnerOp("predict", { modelRef: { kind: "job", id }, features, authorization: await grant("job", id, features) }) as Promise<SignedPrediction>;
    const verified = (result: SignedPrediction) => verifyTypedData({
      address: result.signer, domain: result.domain, primaryType: "Prediction", types: PREDICTION_EIP712_TYPES,
      message: { ...result.signedMessage, counter: BigInt(result.signedMessage.counter), sessionRevision: BigInt(result.signedMessage.sessionRevision) },
      signature: result.signature,
    });

    // Arbres : décision « 1 » si score ≥ 0.
    const features = { age: 12 };
    const authorization = await grant("job", "job-1", features);
    const first = await handleRunnerOp("predict", { modelRef: { kind: "job", id: "job-1" }, features, authorization }) as SignedPrediction;
    assert.deepEqual([first.modelRef, first.modelId, first.modelVersion, first.outputKind, first.output, first.counter],
      ["job:job-1", "gradient_boosted_trees", "1.1.0", "decision", "1", 1]);
    assert.equal("probability" in first || "score" in first || "decision" in first, false);
    assert.deepEqual(first.domain, { name: "SiriusPrediction", version: "2", chainId: evmEscrowBinding().chainId });
    assert.equal(first.signedMessage.subject, owner);
    assert.equal(first.signedMessage.sessionRevision, 1);
    assert.equal(first.signedMessage.featuresHash, keccak256(stringToHex(JSON.stringify(features))));
    assert.equal(await verified(first), true);
    assert.equal(await verified({ ...first, signedMessage: { ...first.signedMessage, output: "0" } }), false);
    // Rejeu, scope, variables : refusés avant tout décompte.
    await assert.rejects(handleRunnerOp("predict", { modelRef: { kind: "job", id: "job-1" }, features, authorization }), /déjà utilisé/);
    await assert.rejects(handleRunnerOp("predict", { modelRef: { kind: "job", id: "job-1" }, features,
      authorization: await grant("job", "job-1", features, "other") }), /hors scope/);
    await assert.rejects(handleRunnerOp("predict", { modelRef: { kind: "job", id: "job-1" }, features,
      authorization: await grant("loan", "job-1", features) }), /hors scope|invalide/);
    await assert.rejects(predictJob("job-1", { age: 12, leak: 1 }), /hors modèle/);
    await assert.rejects(handleRunnerOp("predict", { modelRef: { kind: "job", id: "job-1" }, features: { age: Number.POSITIVE_INFINITY } }), /invalides/);
    await assert.rejects(handleRunnerOp("predict", { modelRef: { kind: "job", id: "job-1" }, features: { age: 1e10 } }), /invalides/);
    await assert.rejects(handleRunnerOp("predict", { modelRef: { kind: "dataset", id: "job-1" }, features }), /modelRef invalide/);
    await assert.rejects(predictJob("job-2", { age: 1 }), /Modèle indisponible/);
    const second = await predictJob("job-1", { age: 5 });
    assert.deepEqual([second.output, second.counter], ["0", 2]);

    // Linéaire : valeur arrondie à 3 chiffres significatifs.
    const value = await predictJob("job-lin", { size: 10 });
    assert.deepEqual([value.modelRef, value.outputKind, value.output, value.counter], ["job:job-lin", "value", "24.5", 1]);
    assert.equal(await verified(value), true);
    assert.equal((await predictJob("job-lin", { size: 1e6 })).output, "2350000");
    assert.equal((await predictJob("job-lin", { size: -0.001 })).output, "0.998");

    // Quota quotidien par (sujet, modelRef) : job-1 épuisé, les autres modèles intacts.
    assert.equal((await predictJob("job-1", { age: 11 })).counter, 3);
    await assert.rejects(predictJob("job-1", { age: 11 }), /Quota quotidien/);

    // Prêt (logistique) : reçu exigé, emprunteur seul, règlement publié avant toute prédiction.
    const { chainId, escrow } = evmEscrowBinding();
    const loanReceipt = issueLoanReceipt({ loanId: "loan-1", datasetId: "dataset-1", borrower: owner,
      provider: `0x${"56".repeat(20)}`, modelCid: servedModelFingerprint(logistic), loanKey: `0x${"ab".repeat(32)}`,
      chainId, escrow, amountUsdcAtomic: "1", challengeDays: 1, modelId: "logistic_regression", modelVersion: "1.0.0",
      attestationHash: "a".repeat(64) });
    const predictLoan = async (loanFeatures: Record<string, number>, receipt = loanReceipt) =>
      handleRunnerOp("predict", { modelRef: { kind: "loan", id: "loan-1" }, features: loanFeatures,
        authorization: await grant("loan", "loan-1", loanFeatures), loanReceipt: receipt, settleTxHash: `0x${"cd".repeat(32)}` }) as Promise<SignedPrediction>;
    await assert.rejects(handleRunnerOp("predict", { modelRef: { kind: "loan", id: "loan-1" }, features: { x: 3, y: 0 },
      authorization: await grant("loan", "loan-1", { x: 3, y: 0 }) }), /loanReceipt invalide/);
    const otherLoan = issueLoanReceipt({ loanId: "loan-2", datasetId: "dataset-1", borrower: owner,
      provider: `0x${"56".repeat(20)}`, modelCid: "sm1", loanKey: `0x${"ab".repeat(32)}`, chainId, escrow,
      amountUsdcAtomic: "1", challengeDays: 1, modelId: "logistic_regression", modelVersion: "1.0.0", attestationHash: "a".repeat(64) });
    await assert.rejects(predictLoan({ x: 3, y: 0 }, otherLoan), /hors scope/);
    await assert.rejects(predictLoan({ x: 3, y: 0 }), (error: Error & { status?: number }) =>
      error.status === 409 && /Préimage pas encore publié/.test(error.message));
    preimageRevealed = true;
    const loanDecision = await predictLoan({ x: 3, y: 0 });
    assert.deepEqual([loanDecision.modelRef, loanDecision.modelId, loanDecision.outputKind, loanDecision.output, loanDecision.counter],
      ["loan:loan-1", "logistic_regression", "decision", "1", 1], "quota et compteur propres au prêt");
    assert.equal(await verified(loanDecision), true);
    assert.equal((await predictLoan({ x: 1, y: 0 })).output, "0");

    // Un autre wallet : ni le modèle d'un job, ni celui d'un prêt dont il n'est pas l'emprunteur.
    const stranger = privateKeyToAccount(`0x${"11".repeat(32)}`);
    useWalletStore.getState().setConnected(stranger.address, "testnet", "external");
    const strangerKey = await beginRunnerDelegation();
    const strangerMessage = buildDelegationMessage({ origin, address: stranger.address, sessionPublicKey: strangerKey,
      network: "testnet", issuedAt: now, expiresAt: now + 60_000, challengeToken: "challenge.signature" });
    await activateRunnerDelegation({ message: strangerMessage,
      walletSignature: await stranger.signMessage({ message: strangerMessage }), sessionPublicKey: strangerKey });
    await assert.rejects(predictJob("job-lin", { size: 1 }), /réservée au propriétaire/);
    await assert.rejects(predictLoan({ x: 3, y: 0 }), /réservée à l’emprunteur/);

    session.command("close", 1, owner);
    await assert.rejects(handleRunnerOp("predict", {}), /fermée/);
  } finally {
    globalThis.fetch = originalFetch;
    robinhoodTestnet.contracts = chainContracts;
    if (sessionOpened) demoSessions().close();
    try { runnerBudget()?.close(); } catch { /* conserve l'erreur initiale du scénario */ }
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});
