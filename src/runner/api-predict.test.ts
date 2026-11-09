import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { encodeFunctionResult, keccak256, stringToHex, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { useWalletStore } from "@/stores/wallet";
import { AppError } from "@/lib/app-error";
import { activateRunnerDelegation, beginRunnerDelegation, issueRunnerGrant } from "@/lib/runner/authorization-client";
import { buildDelegationMessage } from "@/lib/runner/authorization-contract";
import { issueRunnerCapability } from "@/lib/runner/capability";
import { issueLoanReceipt } from "@/lib/runner/receipt";
import { creditCallPack, recordApiAccessPass } from "@/lib/runner/prediction-usage";
import { runnerBudget } from "@/lib/runner/budget";
import { initializeBudgetLedger } from "@/lib/runner/budget-ledger";
import { verifyApiSignature } from "@/lib/runner/api-signature";
import { apiCanonicalString } from "@/lib/billing/api-pricing";
import { DAY_MS } from "@/lib/billing/rental";
import { robinhoodTestnet } from "@/lib/evm/networks";
import { siriusescrowAbi } from "@/lib/evm/abi/siriusescrow";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import { registerApiKey } from "@/lib/tee/api-keys";
import { apiKeyEnvelopeSha256, encryptApiKeySecretForRunner } from "@/lib/tee/ingress-client";
import { datasetIngressPublicKey } from "@/lib/tee/ingress";
import { recordLoanExpiry, saveServedModel, servedModelFingerprint } from "@/lib/tee/served-models";
import { PREDICTION_EIP712_TYPES, type ApiModelInfo, type ApiPrediction, type SignedPrediction } from "@/lib/tee/contract";
import type { DeliveredModel, LinearRegressionModel, LogisticRegressionModel } from "@/lib/models/registry";
import { handleRunnerOp } from "./handler";
import { handleRunnerRequest } from "./server";

const RPC_URL = "http://rpc.test.invalid/";
const logistic: LogisticRegressionModel = {
  algo: "logistic_regression", version: "1.0.0", target: "default", features: ["x", "y"], coefficients: [-1, 0.5, 0],
  metrics: { accuracy: 0.7, precision: 0.7, recall: 0.7, f1: 0.7, n: 100 },
};
const linear: LinearRegressionModel = {
  algo: "linear_regression", version: "1.0.0", target: "price", features: ["x", "y"], coefficients: [1, 2, 3],
  metrics: { r2: 0.9, rmse: 1, mae: 1, n: 100 },
};
const vector = JSON.parse(readFileSync(resolve("sdk/fixtures/api-signing-vector.json"), "utf8")) as {
  keyId: string; secret: string; loanId: string;
  predict: { method: string; path: string; timestamp: number; nonce: string; body: string; signature: string };
  info: { method: string; path: string; timestamp: number; nonce: string; body: string; signature: string };
};
const fixtureModel: LogisticRegressionModel = { ...logistic, features: ["age", "income"] };

interface ApiKey { keyId: string; secret: Buffer }
const newKey = (): ApiKey => ({ keyId: randomBytes(16).toString("base64url"), secret: randomBytes(32) });
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const seconds = () => Math.floor(Date.now() / 1_000);

function rejection(code: string, status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof AppError, `AppError attendue, reçu ${String(error)}`);
    assert.deepEqual([error.code, error.status], [code, status], error.message);
    return true;
  };
}

test("API développeurs : clés scellées, requêtes signées HMAC, quota du jour puis crédits", async () => {
  const root = mkdtempSync(join(tmpdir(), "sirius-api-predict-"));
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const chainContracts = robinhoodTestnet.contracts;
  const account = privateKeyToAccount(`0x${"59c6995e998f97a5a0044966f094538b2927f5fc5a8c7e1b3e49b920e33e9f8a"}`);
  const owner = account.address.toLowerCase();
  const origin = "https://app.example";
  Object.assign(process.env, {
    NODE_ENV: "test", EVM_NETWORK: "testnet", TEE_MODE: "stub", SIRIUS_PHALA_DEMO: "false", SIRIUS_BILLING_VERSION: "7",
    EVM_RPC_URL: RPC_URL, SIRIUS_APP_ORIGIN: origin, SIRIUS_LOCK_AUTHORIZER: owner, SIRIUS_ESCROW_ADDRESS: `0x${"34".repeat(20)}`,
    SIRIUS_MASTER_KEY: Buffer.alloc(32, 31).toString("base64"), RUNNER_TRANSPORT_SECRET: Buffer.alloc(32, 37).toString("base64"),
    RUNNER_PREDICT_USAGE_FILE: join(root, "usage.sqlite"), RUNNER_SERVED_MODELS_DIR: join(root, "models"),
    RUNNER_BILLING_POLICY_FILE: join(root, "tariff.json"), RUNNER_PREDICT_DAILY_LIMIT: "24",
  });
  for (const key of ["RUNNER_BUDGET_FILE", "RUNNER_REPLAY_DIR", "RUNNER_URL"]) delete process.env[key];
  const profile = { computeAmount: "7000000", maxFailureFee: "100000", executionRateAtomicPerMs: "1", maxExecutionMs: 10_000 };
  writeFileSync(process.env.RUNNER_BILLING_POLICY_FILE!, JSON.stringify({
    version: 1, tariffVersion: "api-test", costReference: "synthetic", validUntil: Date.now() + 7 * DAY_MS,
    chainId: evmEscrowBinding().chainId, usdc: `0x${"56".repeat(20)}`, usdcDecimals: 6, computeRecipient: `0x${"78".repeat(20)}`,
    minimumComputeAmount: "7000000", noTrainingComputeAmount: "100000",
    apiCallsPerDay: { logistic_regression: 2, gradient_boosted_trees: 100 },
    profiles: { linear_regression: profile, logistic_regression: profile },
  }), { mode: 0o600 });
  robinhoodTestnet.contracts = undefined;
  // Registre de budget réel : les opérations API n'y réservent rien, la prédiction du site si.
  process.env.RUNNER_BUDGET_FILE = join(root, "ledger.sqlite");
  initializeBudgetLedger(process.env.RUNNER_BUDGET_FILE, {
    version: 1, chainId: evmEscrowBinding().chainId, wallet: owner, accountingReference: "fixture-synthetic-not-revenue",
    validUntil: Date.now() + 7 * DAY_MS, earnedMarginUsdMicros: "1000", cashUsdMicros: "1000", fixedReserveUsdMicros: "100",
    costsUsdMicros: { request: "1", seal: "50", training: "100" },
    gas: { totalWei: "200000000000", maxTransactionWei: "100000000000", maxGas: "100000", maxFeePerGasWei: "1000000", ethUsdMicrosUpperBound: "5000000000", confirmations: 2 },
    maxFailures: 3, maxActive: 8,
  });
  const allocated = () => runnerBudget()!.snapshot().allocatedUsd;
  // Prêts hérités réglés : le faux RPC publie leur préimage ; aucun autre appel réseau.
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), RPC_URL, "aucun appel réseau hors RPC");
    const rpc = JSON.parse(String(init?.body)) as { id: number; method: string };
    assert.equal(rpc.method, "eth_call");
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: encodeFunctionResult({
      abi: siriusescrowAbi, functionName: "preimageOf", result: [true, `0x${"77".repeat(32)}`],
    }) });
  };
  // Tout ce qui sort du runner (réponses, erreurs, journaux) est relu à la fin : jamais un secret.
  const emitted: string[] = [];
  const consoleMethods = ["log", "info", "warn", "error", "debug"] as const;
  const originalConsole = Object.fromEntries(consoleMethods.map((name) => [name, console[name]]));
  for (const name of consoleMethods) console[name] = (...args: unknown[]) => { emitted.push(args.map(String).join(" ")); };
  const secrets: Buffer[] = [];
  try {
    const { chainId, escrow } = evmEscrowBinding();
    const receipts: Record<string, string> = {};
    const expiries: Record<string, number> = {};
    const settleTxHash = `0x${"cd".repeat(32)}`;
    // Chaque prêt de la fixture porte un pass d'accès API (D-32) jusqu'à son échéance, sauf `paid = false`.
    function loan(loanId: string, model: DeliveredModel, expiresAt = Date.now() + DAY_MS, paid = true) {
      saveServedModel({ kind: "loan", id: loanId }, owner, model);
      expiries[loanId] = recordLoanExpiry(loanId, expiresAt);
      if (paid) recordApiAccessPass({ passLoanId: `pass-${loanId}`, originalLoanId: loanId, subject: owner, days: 1, releasedAt: Date.now(), rentalExpiresAt: expiresAt });
      receipts[loanId] = issueLoanReceipt({ loanId, datasetId: "dataset-1", borrower: owner, provider: `0x${"56".repeat(20)}`,
        modelCid: servedModelFingerprint(model), loanKey: `0x${"ab".repeat(32)}`, chainId, escrow, amountUsdcAtomic: "1",
        challengeDays: 1, modelId: model.algo, modelVersion: model.version, attestationHash: "a".repeat(64) });
    }
    loan("loan-1", logistic);
    loan("loan-2", logistic);
    loan("loan-lin", linear);
    loan("loan-short", logistic, Date.now() + 60 * 60_000);
    loan("loan-past", logistic, Date.now() - 1);
    loan(vector.loanId, fixtureModel);
    loan("loan-unpaid", logistic, Date.now() + 2 * DAY_MS, false);

    async function call<T>(op: Parameters<typeof handleRunnerOp>[0], body: Record<string, unknown>): Promise<T> {
      try {
        const result = await handleRunnerOp(op, body);
        emitted.push(JSON.stringify(result));
        return result as T;
      } catch (error) {
        emitted.push(String((error as Error).message), JSON.stringify(error));
        throw error;
      }
    }
    async function delegate(wallet: typeof account) {
      useWalletStore.getState().setConnected(wallet.address, "testnet", "external");
      const sessionPublicKey = await beginRunnerDelegation();
      const now = Date.now();
      const message = buildDelegationMessage({ origin, address: wallet.address, sessionPublicKey, network: "testnet",
        issuedAt: now, expiresAt: now + 60_000, challengeToken: "challenge.signature" });
      await activateRunnerDelegation({ message, walletSignature: await wallet.signMessage({ message }), sessionPublicKey });
    }
    async function registration(loanId: string, key: ApiKey, envelopeFor: ApiKey = key) {
      secrets.push(key.secret, envelopeFor.secret);
      const envelope = await encryptApiKeySecretForRunner(envelopeFor.secret.toString("base64url"), key.keyId, datasetIngressPublicKey());
      const authorization = await issueRunnerGrant("register-api-key", { loanId }, [loanId, key.keyId, await apiKeyEnvelopeSha256(envelope)]);
      return { loanId, keyId: key.keyId, envelope, authorization, loanReceipt: receipts[loanId], settleTxHash };
    }
    const register = async (loanId: string, key: ApiKey) =>
      call<{ keyId: string; createdAt: number }>("register-api-key", await registration(loanId, key));
    function signed(key: ApiKey, loanId: string, op: "predict" | "info", options: {
      body?: string; signedBody?: string; timestamp?: number; nonce?: string; path?: string; method?: string; signature?: string;
    } = {}) {
      const method = options.method ?? (op === "predict" ? "POST" : "GET");
      const path = options.path ?? (op === "predict" ? `/v1/models/${loanId}/predict` : `/v1/models/${loanId}`);
      const body = options.body ?? (op === "predict" ? JSON.stringify({ features: { x: 3, y: 0 } }) : "");
      const timestamp = options.timestamp ?? seconds();
      const nonce = options.nonce ?? randomBytes(16).toString("base64url");
      const signature = options.signature ?? createHmac("sha256", key.secret)
        .update(apiCanonicalString({ method, path, timestamp, nonce, bodySha256Hex: sha256(options.signedBody ?? body) })).digest("hex");
      return { loanId, keyId: key.keyId, method, path, timestamp, nonce, signature, body, loanReceipt: receipts[loanId], settleTxHash };
    }
    const predict = (request: Record<string, unknown>) => call<ApiPrediction>("api-predict", request);
    const info = (request: Record<string, unknown>) => call<ApiModelInfo>("api-info", request);
    const verified = (result: SignedPrediction) => verifyTypedData({
      address: result.signer, domain: result.domain, primaryType: "Prediction", types: PREDICTION_EIP712_TYPES,
      message: { ...result.signedMessage, counter: BigInt(result.signedMessage.counter), sessionRevision: BigInt(result.signedMessage.sessionRevision) },
      signature: result.signature,
    });

    await delegate(account);

    // --- Enregistrement : grant de l'emprunteur, prêt réglé, location en cours, profil admis. ---
    const key = newKey();
    const created = await register("loan-1", key);
    assert.deepEqual(Object.keys(created).sort(), ["createdAt", "keyId"], "aucun secret dans la réponse");
    assert.equal(created.keyId, key.keyId);
    assert.deepEqual(await register("loan-1", key), created, "même clé, même secret : idempotent");
    await assert.rejects(call("register-api-key", await registration("loan-1", key, newKey())), rejection("key_conflict", 409));
    const forged = await registration("loan-1", newKey());
    await assert.rejects(call("register-api-key", { ...forged, envelope: (await registration("loan-1", newKey())).envelope }),
      /hors scope/, "enveloppe remplacée après la signature du grant");
    await assert.rejects(register("loan-lin", newKey()), rejection("api_not_available_for_profile", 409), "pas de clé pour la linéaire");
    await assert.rejects(register("loan-past", newKey()), rejection("rental_expired", 403));

    // --- Signature : chaque altération est refusée avant tout décompte. ---
    const first = await predict(signed(key, "loan-1", "predict"));
    assert.deepEqual([first.modelRef, first.modelId, first.outputKind, first.output, first.counter], ["loan:loan-1", "logistic_regression", "decision", "1", 1]);
    assert.deepEqual(first.remaining, { today: 1, credits: 0 });
    assert.equal(first.expiresAt, expiries["loan-1"]);
    assert.equal(first.signedMessage.subject, owner);
    assert.equal(first.signedMessage.featuresHash, keccak256(stringToHex(JSON.stringify({ x: 3, y: 0 }))));
    assert.equal(await verified(first), true);

    const genuine = signed(key, "loan-1", "predict");
    const flipped = `${genuine.signature.slice(0, -1)}${genuine.signature.endsWith("0") ? "1" : "0"}`;
    await assert.rejects(predict({ ...genuine, signature: flipped }), rejection("invalid_signature", 401), "signature modifiée");
    await assert.rejects(predict(signed(key, "loan-1", "predict", { signedBody: JSON.stringify({ features: { x: 1, y: 0 } }) })),
      rejection("invalid_signature", 401), "corps modifié");
    await assert.rejects(predict(signed(key, "loan-1", "predict", { path: "/v1/models/loan-2/predict" })),
      rejection("invalid_signature", 401), "chemin d'un autre prêt");
    await assert.rejects(predict({ ...signed(key, "loan-1", "info"), body: genuine.body }), rejection("invalid_signature", 401),
      "une signature d'info ne vaut pas une prédiction");
    await assert.rejects(predict(signed(key, "loan-1", "predict", { method: "PUT" })), rejection("invalid_signature", 401));
    await assert.rejects(predict(signed(key, "loan-1", "predict", { path: "/api/v1/models/loan-1/predict" })),
      rejection("invalid_signature", 401), "chemin public seulement");
    await assert.rejects(predict(signed(key, "loan-1", "predict", { timestamp: seconds() - 302 })), rejection("request_expired", 401));
    await assert.rejects(predict(signed(key, "loan-1", "predict", { timestamp: seconds() + 302 })), rejection("request_expired", 401));
    await assert.rejects(predict(signed(newKey(), "loan-1", "predict")), rejection("unknown_key", 401));
    await assert.rejects(predict(signed(key, "loan-2", "predict")), rejection("unknown_key", 401), "clé d'un autre prêt");
    await assert.rejects(predict(signed(key, "loan-1", "predict", { body: JSON.stringify({ features: { x: 3 } }) })),
      rejection("invalid_features", 400));
    await assert.rejects(predict(signed(key, "loan-1", "predict", { body: JSON.stringify({ features: { x: 3, y: 0 }, extra: 1 }) })),
      rejection("invalid_features", 400));
    await assert.rejects(predict(signed(key, "loan-1", "predict", { body: "pas du JSON" })), rejection("invalid_features", 400));
    assert.deepEqual((await info(signed(key, "loan-1", "info"))).remaining, { today: 1, credits: 0 }, "aucun refus n'a consommé de quota");

    // --- Anti-rejeu : un nonce ne sert qu'une fois, même requête intacte. ---
    const once = signed(key, "loan-1", "predict", { timestamp: seconds() - 298 });
    const second = await predict(once);
    assert.deepEqual([second.counter, second.remaining], [2, { today: 0, credits: 0 }], "horodatage dans la fenêtre de ±300 s");
    await assert.rejects(predict(once), rejection("replayed_request", 409));

    // --- Quota : le jour (apiCallsPerDay = 2) est épuisé, aucun crédit ⇒ 429. ---
    await assert.rejects(predict(signed(key, "loan-1", "predict")), rejection("quota_exceeded", 429));
    assert.equal(creditCallPack({ packLoanId: "pack-1", originalLoanId: "loan-1", subject: owner, calls: 100 }), 100);
    const credited = await predict(signed(key, "loan-1", "predict"));
    assert.deepEqual([credited.counter, credited.remaining], [3, { today: 0, credits: 99 }], "puis les crédits de packs");
    const described = await info(signed(key, "loan-1", "info"));
    assert.deepEqual(described, { loanId: "loan-1", modelId: "logistic_regression", modelVersion: "1.0.0", features: ["x", "y"],
      expiresAt: expiries["loan-1"], remaining: { today: 0, credits: 99 } });
    assert.deepEqual((await info(signed(key, "loan-1", "info"))).remaining, { today: 0, credits: 99 }, "api-info ne consomme rien");
    await assert.rejects(info(signed(key, "loan-1", "info", { body: "{}" })), /Corps de requête inattendu/);
    assert.equal(allocated(), BigInt(0), "clés, prédictions et descriptions API : aucune allocation du budget global");
    // Site et API partagent le même compteur de prêt.
    const features = { x: 1, y: 0 };
    const site = await call<SignedPrediction>("predict", { modelRef: { kind: "loan", id: "loan-1" }, features, loanReceipt: receipts["loan-1"],
      settleTxHash, authorization: await issueRunnerGrant("predict", { loanId: "loan-1" }, ["loan", "loan-1", JSON.stringify(features)]) });
    assert.equal(site.counter, 4);
    assert.equal(allocated(), BigInt(1), "la prédiction du site reste une requête budgétée");
    assert.deepEqual((await info(signed(key, "loan-1", "info"))).remaining, { today: 0, credits: 98 });

    // --- Vecteur partagé avec les SDK (sdk/fixtures/api-signing-vector.json). ---
    const fixtureKey: ApiKey = { keyId: vector.keyId, secret: Buffer.from(vector.secret, "base64url") };
    await register(vector.loanId, fixtureKey);
    assert.equal(verifyApiSignature({ secret: fixtureKey.secret, ...vector.predict }), true);
    assert.equal(verifyApiSignature({ secret: fixtureKey.secret, ...vector.info }), true);
    assert.equal(verifyApiSignature({ secret: fixtureKey.secret, ...vector.info, path: vector.predict.path }), false);
    Date.now = () => vector.predict.timestamp * 1_000 + 1_000;
    const fixtureRequest = (part: typeof vector.predict, signature = part.signature) => ({ loanId: vector.loanId, keyId: vector.keyId,
      ...part, signature, loanReceipt: receipts[vector.loanId], settleTxHash });
    const fixtureInfo = vector.info.signature;
    await assert.rejects(info(fixtureRequest(vector.info, `${fixtureInfo.slice(0, -1)}${fixtureInfo.endsWith("0") ? "1" : "0"}`)),
      rejection("invalid_signature", 401));
    const fromSdk = await predict(fixtureRequest(vector.predict));
    assert.deepEqual([fromSdk.modelRef, fromSdk.counter, fromSdk.remaining], [`loan:${vector.loanId}`, 1, { today: 1, credits: 0 }]);
    // Même nonce que la prédiction : la signature est valide, le rejeu ne l'est pas.
    await assert.rejects(info(fixtureRequest(vector.info)), rejection("replayed_request", 409));
    Date.now = originalNow;

    // --- Location expirée : refusée avant tout décompte. ---
    const shortKey = newKey();
    await register("loan-short", shortKey);
    Date.now = () => expiries["loan-short"] + 1;
    await assert.rejects(predict(signed(shortKey, "loan-short", "predict")), rejection("rental_expired", 403));
    await assert.rejects(info(signed(shortKey, "loan-short", "info")), rejection("rental_expired", 403));
    Date.now = originalNow;
    assert.deepEqual((await info(signed(shortKey, "loan-short", "info"))).remaining, { today: 2, credits: 0 });

    // --- Linéaire : même une clé présente dans le registre ne sert pas (D-27). ---
    const linearKey = newKey();
    secrets.push(linearKey.secret);
    registerApiKey({ loanId: "loan-lin", keyId: linearKey.keyId, owner, secret: linearKey.secret });
    await assert.rejects(predict(signed(linearKey, "loan-lin", "predict")), rejection("api_not_available_for_profile", 409));
    await assert.rejects(info(signed(linearKey, "loan-lin", "info")), rejection("api_not_available_for_profile", 409));

    // --- Pass d'accès API (D-32) : sans journée payée couvrant l'instant, ni clé, ni appel. ---
    const unpaidKey = newKey();
    await assert.rejects(register("loan-unpaid", unpaidKey), rejection("api_access_required", 403), "pas de clé sans pass");
    secrets.push(unpaidKey.secret);
    registerApiKey({ loanId: "loan-unpaid", keyId: unpaidKey.keyId, owner, secret: unpaidKey.secret });
    await assert.rejects(predict(signed(unpaidKey, "loan-unpaid", "predict")), rejection("api_access_required", 403));
    await assert.rejects(info(signed(unpaidKey, "loan-unpaid", "info")), rejection("api_access_required", 403));
    const siteFeatures = { x: 2, y: 0 };
    const siteOnly = await call<SignedPrediction>("predict", { modelRef: { kind: "loan", id: "loan-unpaid" }, features: siteFeatures,
      loanReceipt: receipts["loan-unpaid"], settleTxHash,
      authorization: await issueRunnerGrant("predict", { loanId: "loan-unpaid" }, ["loan", "loan-unpaid", JSON.stringify(siteFeatures)]) });
    assert.equal(siteOnly.counter, 1, "la prédiction du site reste incluse sans pass");
    // Pass d'un jour sur une location de deux : couvert jusqu'à release + 1 jour, refusé au-delà.
    const releasedAt = Date.now();
    const coverage = recordApiAccessPass({ passLoanId: "pass-unpaid", originalLoanId: "loan-unpaid", subject: owner, days: 1, releasedAt,
      rentalExpiresAt: expiries["loan-unpaid"] });
    assert.equal(coverage, releasedAt + DAY_MS);
    assert.equal(recordApiAccessPass({ passLoanId: "pass-unpaid", originalLoanId: "loan-unpaid", subject: owner, days: 1, releasedAt: releasedAt + 5,
      rentalExpiresAt: expiries["loan-unpaid"] }), coverage, "pass rejoué : couverture inchangée");
    assert.equal((await predict(signed(unpaidKey, "loan-unpaid", "predict"))).counter, 2);
    assert.equal((await info(signed(unpaidKey, "loan-unpaid", "info"))).loanId, "loan-unpaid");
    Date.now = () => coverage + 1;
    assert.ok(Date.now() < expiries["loan-unpaid"], "location encore en cours");
    await assert.rejects(predict(signed(unpaidKey, "loan-unpaid", "predict")), rejection("api_access_required", 403), "après la fin de la couverture");
    Date.now = originalNow;

    // --- Révocation : grant de l'emprunteur, idempotente, la clé est refusée ensuite. ---
    const revoke = async (loanId: string, keyId: string) => call<{ keyId: string; revokedAt: number }>("revoke-api-key", {
      loanId, keyId, authorization: await issueRunnerGrant("revoke-api-key", { loanId }, [loanId, keyId]) });
    const revoked = await revoke("loan-1", key.keyId);
    assert.equal(revoked.keyId, key.keyId);
    assert.deepEqual(await revoke("loan-1", key.keyId), revoked);
    await assert.rejects(predict(signed(key, "loan-1", "predict")), rejection("key_revoked", 401));
    await assert.rejects(info(signed(key, "loan-1", "info")), rejection("key_revoked", 401));
    assert.equal(allocated(), BigInt(2), "révocation et refus API : aucune allocation (seules les deux prédictions du site en ont une)");

    // --- HTTP : le code stable traverse le serveur runner. ---
    const unknown = signed(newKey(), "loan-1", "predict");
    const raw = JSON.stringify(unknown);
    const req = Readable.from([raw]) as IncomingMessage;
    Object.assign(req, { method: "POST", url: "/api-predict", headers: {
      "content-length": String(Buffer.byteLength(raw)), "x-sirius-runner-capability": issueRunnerCapability("api-predict", { loanId: "loan-1" }),
    } });
    let status = 0;
    let responseBody = "";
    await handleRunnerRequest(req, {
      writeHead(code: number) { status = code; return this; },
      end(chunk: string) { responseBody = chunk; return this; },
    } as unknown as ServerResponse);
    assert.equal(status, 401);
    assert.deepEqual(JSON.parse(responseBody), { error: "Clé API inconnue pour ce modèle", code: "unknown_key" });

    // --- Un autre wallet : ni enregistrement ni révocation sur le prêt d'autrui. ---
    const stranger = privateKeyToAccount(`0x${"11".repeat(32)}`);
    await delegate(stranger);
    await assert.rejects(register("loan-2", newKey()), /réservée à l’emprunteur/);
    await assert.rejects(revoke("loan-short", shortKey.keyId), /réservée à l’emprunteur/);
    assert.deepEqual((await info(signed(shortKey, "loan-short", "info"))).remaining, { today: 2, credits: 0 }, "clé toujours active");

    // --- Le secret ne sort jamais : ni réponse, ni erreur, ni journal, ni fichier en clair. ---
    const disk = readdirSync(process.env.RUNNER_SERVED_MODELS_DIR!).map((name) => readFileSync(join(process.env.RUNNER_SERVED_MODELS_DIR!, name), "utf8"));
    for (const secret of [...secrets, fixtureKey.secret, shortKey.secret]) {
      for (const encoded of [secret.toString("base64url"), secret.toString("base64"), secret.toString("hex")]) {
        assert.equal(emitted.some((line) => line.includes(encoded)), false, "secret dans une réponse ou un journal");
        assert.equal(disk.some((content) => content.includes(encoded)), false, "secret en clair sur le volume");
      }
    }
  } finally {
    Date.now = originalNow;
    for (const name of consoleMethods) console[name] = originalConsole[name] as typeof console.log;
    globalThis.fetch = originalFetch;
    robinhoodTestnet.contracts = chainContracts;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});
