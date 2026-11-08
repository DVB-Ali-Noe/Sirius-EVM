import assert from "node:assert/strict";
import { before, test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { useWalletStore } from "@/stores/wallet";
import { activateRunnerDelegation, beginRunnerDelegation, issueRunnerGrant } from "@/lib/runner/authorization-client";
import { buildDelegationMessage } from "@/lib/runner/authorization-contract";
import { verifyDatasetReceipt } from "@/lib/runner/receipt";
import { RunnerRetryLater } from "@/lib/runner/failure-policy";
import { AppError } from "@/lib/app-error";
import { buildMerkleTree } from "@/lib/crypto/merkle";
import { priceUsdcToAtomic } from "@/lib/evm/usdc";
import { datasetIngressPublicKey } from "@/lib/tee/ingress";
import type { AuthorizedSealDatasetResult } from "@/lib/tee/contract";
import type { R2Config } from "@/lib/storage/r2";
import {
  ChunkedUploadEncryptor,
  MERKLE_LEAF_BYTES,
  chunkObjectKey,
  decodeBase64Url,
  manifestSha256,
  type ChunkedUploadManifest,
} from "@/lib/upload/chunked";
import { ChunkedSealJobs, r2SealSource } from "./chunked-seal-jobs";
import { handleRunnerOp, scopeForRunnerOp } from "./handler";

const ORIGIN = "http://localhost:3000";
const R2 = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "runner-read",
  R2_SECRET_ACCESS_KEY: "runner-secret",
  R2_BUCKET: "sirius-test",
};
const CONFIG: R2Config = { accountId: R2.R2_ACCOUNT_ID, accessKeyId: "k", secretAccessKey: "s", bucket: R2.R2_BUCKET };

before(() => {
  Object.assign(process.env, {
    TEE_MODE: "stub",
    SIRIUS_MASTER_KEY: Buffer.alloc(32, 11).toString("base64"),
    EVM_NETWORK: "testnet",
    SIRIUS_APP_ORIGIN: ORIGIN,
    SIRIUS_ESCROW_ADDRESS: `0x${"34".repeat(20)}`,
    // Fixture linéaire : profil facultatif depuis D-31, activé explicitement.
    NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS: "linear_regression",
    ...R2,
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, ko) => {
    resolve = ok;
    reject = ko;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const FAKE_RESULT = { cid: "c", wrappedKey: "w", merkleRoot: "m", sizeBytes: 1, runnerReceipt: "r" } as unknown as AuthorizedSealDatasetResult;

test("un scellement tourne en arrière-plan, un seul à la fois, et son état se relit", async () => {
  const jobs = new ChunkedSealJobs();
  const first = { datasetId: "d1", uploadId: "u1" };
  const run = deferred<AuthorizedSealDatasetResult>();
  assert.equal(jobs.start(first, () => run.promise).state, "sealing");
  assert.equal(jobs.status(first).state, "sealing");

  assert.throws(() => jobs.start(first, () => run.promise), (error: unknown) => error instanceof AppError && error.status === 409);
  assert.throws(() => jobs.start({ datasetId: "d2", uploadId: "u2" }, () => run.promise), (error: unknown) => error instanceof RunnerRetryLater);

  run.resolve(FAKE_RESULT);
  await tick();
  assert.deepEqual(jobs.status(first), { state: "sealed", result: FAKE_RESULT });
  assert.throws(() => jobs.start(first, () => run.promise), /déjà scellé/);
  assert.throws(() => jobs.status({ datasetId: "d9", uploadId: "u9" }), (error: unknown) => error instanceof AppError && error.status === 404);
});

test("un refus est définitif, une panne passagère se relance", async () => {
  const jobs = new ChunkedSealJobs();
  const ids = { datasetId: "d1", uploadId: "u1" };
  jobs.start(ids, async () => {
    throw new AppError("Morceau 3 illisible", 400);
  });
  await tick();
  assert.deepEqual(jobs.status(ids), { state: "failed", error: "Morceau 3 illisible", status: 400, retryable: false });

  jobs.start(ids, async () => {
    throw new RunnerRetryLater("Stockage momentanément injoignable");
  });
  await tick();
  const state = jobs.status(ids);
  assert.ok(state.state === "failed" && state.retryable && state.status === 503);

  jobs.start(ids, async () => {
    throw new Error("détail interne à ne pas exposer");
  });
  await tick();
  const internal = jobs.status(ids);
  assert.ok(internal.state === "failed" && internal.retryable && !internal.error.includes("détail"));
});

test("un morceau absent est un refus, un stockage injoignable une panne passagère", async () => {
  const ids = { datasetId: "d1", uploadId: "u1" };
  const signal = new AbortController().signal;
  const missing: typeof fetch = async () => new Response("<Error/>", { status: 404 });
  await assert.rejects(
    r2SealSource(CONFIG, ids, signal, missing).readChunk(2),
    (error: unknown) => error instanceof AppError && error.status === 400 && /Morceau 2 absent/.test(error.message),
  );
  const down: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(r2SealSource(CONFIG, ids, signal, down).readChunk(0), (error: unknown) => error instanceof RunnerRetryLater);
});

test("les nouvelles opérations sont limitées au dataset de la capability", () => {
  assert.deepEqual(scopeForRunnerOp("seal-chunked-dataset", { datasetId: "d1", uploadId: "u1" }), {
    op: "seal-chunked-dataset",
    scope: { datasetId: "d1" },
  });
  assert.deepEqual(scopeForRunnerOp("seal-chunked-status", { datasetId: "d1" }), { op: "seal-chunked-status", scope: { datasetId: "d1" } });
  assert.throws(() => scopeForRunnerOp("seal-chunked-status", {}), /datasetId invalide/);
});

// ---------------------------------------------------------------------------------------------------------------
// Bout en bout dans le runner : grant du fournisseur, morceaux relus « dans R2 » (fetch simulé).

async function delegate() {
  const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f094538b2927f5fc5a8c7e1b3e49b920e33e9f8a");
  useWalletStore.getState().setConnected(account.address, "testnet", "external");
  const sessionPublicKey = await beginRunnerDelegation();
  const now = Date.now();
  const message = buildDelegationMessage({
    origin: ORIGIN,
    address: account.address,
    sessionPublicKey,
    network: "testnet",
    issuedAt: now,
    expiresAt: now + 60_000,
    challengeToken: "challenge.signature",
  });
  await activateRunnerDelegation({ message, walletSignature: await account.signMessage({ message }), sessionPublicKey });
  return account.address.toLowerCase();
}

function trainingCsv(rows: number): Buffer {
  const lines = ["x1,x2,x3,target"];
  for (let i = 0; i < rows; i++) lines.push(`${(i * 0.37) % 11},${(i * 1.3) % 7},${i % 97},${(i * 0.5) % 3}`);
  return Buffer.from(`${lines.join("\n")}\n`);
}

const TERMS = { priceUsdcAtomic: priceUsdcToAtomic("2.5")!, challengeDays: 7, maxRentalDays: 90, modelId: "linear_regression", modelVersion: "1.0.0" };

async function grantFor(datasetId: string, uploadId: string, sizeBytes: number, manifestSha: string) {
  return issueRunnerGrant("seal-chunked-dataset", { datasetId }, [
    datasetId,
    uploadId,
    TERMS.priceUsdcAtomic,
    String(TERMS.challengeDays),
    String(sizeBytes),
    manifestSha,
    TERMS.modelId,
    TERMS.modelVersion,
    String(TERMS.maxRentalDays),
  ]);
}

async function waitSealed(datasetId: string, uploadId: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const state = (await handleRunnerOp("seal-chunked-status", { datasetId, uploadId })) as { state: string };
    if (state.state !== "sealing") return state as { state: "sealed"; result: AuthorizedSealDatasetResult } | { state: "failed"; error: string };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("scellement trop long");
}

test("le runner scelle un envoi en morceaux relu dans R2 et signe le même reçu qu'un petit fichier", async () => {
  const subject = await delegate();
  const file = trainingCsv(9000);
  const ids = { datasetId: "dataset-chunked", uploadId: "upload-1" };
  const encryptor = await ChunkedUploadEncryptor.create({
    recipientPublicKey: decodeBase64Url(datasetIngressPublicKey().publicKey),
    ids,
    plainBytes: file.length,
    chunkBytes: MERKLE_LEAF_BYTES,
  });
  const stored = new Map<string, Uint8Array<ArrayBuffer>>();
  for (let i = 0; i < encryptor.chunkCount; i++) {
    const part = new Uint8Array(file.subarray(i * MERKLE_LEAF_BYTES, Math.min((i + 1) * MERKLE_LEAF_BYTES, file.length)));
    stored.set(chunkObjectKey(ids, i), (await encryptor.encrypt(i, part)).object);
  }
  const manifest = await encryptor.manifest();
  const sha = await manifestSha256(manifest);

  const originalFetch = globalThis.fetch;
  const reads: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.host, `${R2.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    const key = url.pathname.replace(`/${R2.R2_BUCKET}/`, "");
    reads.push(key);
    const object = stored.get(key);
    return object ? new Response(object) : new Response("<Error/>", { status: 404 });
  }) as typeof fetch;
  try {
    const body = { ...ids, ...TERMS, sizeBytes: file.length, manifest };
    const authorization = await grantFor(ids.datasetId, ids.uploadId, file.length, sha);
    const started = (await handleRunnerOp("seal-chunked-dataset", { ...body, authorization })) as { state: string };
    assert.equal(started.state, "sealing");
    await assert.rejects(handleRunnerOp("seal-chunked-dataset", { ...body, authorization }), /déjà utilisé|déjà en cours/);

    const sealed = await waitSealed(ids.datasetId, ids.uploadId);
    assert.equal(sealed.state, "sealed", sealed.state === "failed" ? sealed.error : "");
    if (sealed.state !== "sealed") return;
    assert.equal(sealed.result.merkleRoot, buildMerkleTree(file).root);
    assert.equal(sealed.result.cid, `sirius-chunked:v1:${ids.uploadId}:${sha}`);
    assert.equal(reads.length, encryptor.chunkCount);
    const receipt = verifyDatasetReceipt(sealed.result.runnerReceipt, {
      datasetId: ids.datasetId,
      cid: sealed.result.cid,
      wrappedKey: sealed.result.wrappedKey,
      merkleRoot: sealed.result.merkleRoot,
      ...TERMS,
    } as Parameters<typeof verifyDatasetReceipt>[1]);
    assert.equal(receipt.owner, subject);
    assert.equal(receipt.version, 4);

    // Un manifeste réécrit après la signature ne passe pas : le grant porte son empreinte.
    const other = { datasetId: "dataset-chunked-2", uploadId: "upload-1" };
    const forged: ChunkedUploadManifest = { ...JSON.parse(JSON.stringify(manifest)), datasetId: other.datasetId };
    const grant = await grantFor(other.datasetId, other.uploadId, file.length, sha);
    await assert.rejects(
      handleRunnerOp("seal-chunked-dataset", { ...other, ...TERMS, sizeBytes: file.length, manifest: forged, authorization: grant }),
      /hors scope/,
    );
    // Un manifeste d'un autre envoi est refusé avant toute lecture.
    await assert.rejects(
      handleRunnerOp("seal-chunked-dataset", { ...other, ...TERMS, sizeBytes: file.length, manifest, authorization: grant }),
      /ne correspond pas à cet envoi/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("un morceau manquant dans R2 fait échouer le scellement avec un refus clair", async () => {
  await delegate();
  const file = trainingCsv(4000);
  const ids = { datasetId: "dataset-missing", uploadId: "upload-1" };
  const encryptor = await ChunkedUploadEncryptor.create({
    recipientPublicKey: decodeBase64Url(datasetIngressPublicKey().publicKey),
    ids,
    plainBytes: file.length,
    chunkBytes: MERKLE_LEAF_BYTES,
  });
  const stored = new Map<string, Uint8Array<ArrayBuffer>>();
  for (let i = 0; i < encryptor.chunkCount; i++) {
    const part = new Uint8Array(file.subarray(i * MERKLE_LEAF_BYTES, Math.min((i + 1) * MERKLE_LEAF_BYTES, file.length)));
    const { object } = await encryptor.encrypt(i, part);
    if (i !== 1) stored.set(chunkObjectKey(ids, i), object);
  }
  const manifest = await encryptor.manifest();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const key = new URL(String(input)).pathname.replace(`/${R2.R2_BUCKET}/`, "");
    const object = stored.get(key);
    return object ? new Response(object) : new Response("<Error/>", { status: 404 });
  }) as typeof fetch;
  try {
    const authorization = await grantFor(ids.datasetId, ids.uploadId, file.length, await manifestSha256(manifest));
    await handleRunnerOp("seal-chunked-dataset", { ...ids, ...TERMS, sizeBytes: file.length, manifest, authorization });
    const state = await waitSealed(ids.datasetId, ids.uploadId);
    assert.deepEqual(state, { state: "failed", error: "Morceau 1 absent du stockage", status: 400, retryable: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
