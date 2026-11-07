import assert from "node:assert/strict";
import { before, test } from "node:test";
import { AppError } from "@/lib/app-error";
import type { R2Config } from "@/lib/storage/r2";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { ChunkedUploadEncryptor, chunkObjectKey, manifestObjectKey, manifestSha256, type ChunkedUploadManifest } from "@/lib/upload/chunked";
import type * as Module from "./chunked-upload";

// Le client Prisma exige une URL à l'import ; ces tests n'ouvrent aucune connexion (base simulée).
let uploads: typeof Module;
before(async () => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  uploads = await import("./chunked-upload");
});

const PROVIDER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const CONFIG: R2Config = { accountId: "0123456789abcdef0123456789abcdef", accessKeyId: "k", secretAccessKey: "s", bucket: "sirius-test" };
const CHUNK = 64 * 1024;
const GRANT = { payload: { nonce: "n" } } as unknown as RunnerGrant;

type Row = Record<string, unknown>;

/** Filtre Prisma minimal : égalité, `in`, `gt`, `gte`, `lte`. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const c = condition as { in?: unknown[]; gt?: Date; gte?: Date; lte?: Date };
      if (c.in && !c.in.includes(value)) return false;
      if (c.gt && !((value as Date) > c.gt)) return false;
      if (c.gte && !((value as Date) >= c.gte)) return false;
      if (c.lte && !((value as Date) <= c.lte)) return false;
      return true;
    }
    return value === condition;
  });
}

function table(rows: Row[]) {
  return {
    rows,
    async findUnique({ where }: { where: Row }) {
      return rows.find((row) => matches(row, where)) ?? null;
    },
    async findMany({ where, take }: { where: Row; take?: number }) {
      return rows.filter((row) => matches(row, where)).slice(0, take ?? rows.length);
    },
    async findFirst({ where }: { where: Row }) {
      return rows.filter((row) => matches(row, where)).at(-1) ?? null;
    },
    async count({ where }: { where: Row }) {
      return rows.filter((row) => matches(row, where)).length;
    },
    async aggregate({ where }: { where: Row }) {
      return { _sum: { sizeBytes: rows.filter((row) => matches(row, where)).reduce((sum, row) => sum + Number(row.sizeBytes), 0) || null } };
    },
    async create({ data }: { data: Row }) {
      const row = { id: `upload${rows.length + 1}`, state: "OPEN", manifestSha256: null, error: null, createdAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    async updateMany({ where, data }: { where: Row; data: Row }) {
      const hit = rows.filter((row) => matches(row, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    },
  };
}

function harness(sizeBytes = 200_000) {
  const datasets = table([
    { id: "ds1", provider: PROVIDER, status: "DRAFT", ipfsCid: null, wrappedKey: null, keyDestroyedAt: null, runnerKind: "DEVELOPMENT", runnerDeploymentId: null },
  ]);
  const datasetUpload = table([]);
  const db = { dataset: datasets, datasetUpload, $transaction: async (action: (tx: unknown) => Promise<unknown>) => action(db) };
  const stored = new Map<string, number>();
  const calls = { started: [] as Row[], presigned: [] as string[], deleted: [] as string[], put: [] as string[] };
  let sealStatus: () => Promise<unknown> = async () => ({ state: "sealing", startedAt: 0 });
  let startSeal: (input: Row) => Promise<unknown> = async (input) => {
    calls.started.push(input);
    return { state: "sealing", startedAt: 0 };
  };
  let now = Date.UTC(2026, 10, 4);
  const deps = {
    db,
    storage: () => CONFIG,
    list: async (_config: R2Config, prefix: string) =>
      [...stored].filter(([key]) => key.startsWith(prefix)).map(([key, size]) => ({ key, size })),
    put: async (_config: R2Config, key: string, body: Uint8Array) => {
      calls.put.push(key);
      stored.set(key, body.length);
    },
    deletePrefix: async (_config: R2Config, prefix: string) => {
      calls.deleted.push(prefix);
      for (const key of [...stored.keys()]) if (key.startsWith(prefix)) stored.delete(key);
      return 0;
    },
    presign: (_config: R2Config, key: string, _seconds: number, _multipart: unknown, _now: Date, size?: number) => {
      calls.presigned.push(key);
      return `https://r2.test/${key}?size=${size}`;
    },
    ingressKey: async () => ({ publicKey: "ingress" }),
    startSeal: (input: Row) => startSeal(input),
    sealStatus: () => sealStatus(),
    authorize: async (id: string, provider: string) => {
      if (provider !== PROVIDER) throw new AppError("Accès refusé : ressource d’un autre compte", 403);
      return { id, provider, sizeBytes, priceUsdcAtomic: "1000", challengeDays: 7, maxRentalDays: 30, model: { modelId: "linear_regression", modelVersion: "1.0.0" }, runnerKind: "DEVELOPMENT", runnerDeploymentId: null };
    },
    assertRunner: async () => ({}),
    now: () => now,
  } as unknown as Module.ChunkedUploadDeps;
  return {
    deps,
    datasets,
    datasetUpload,
    stored,
    calls,
    setSealStatus: (fn: () => Promise<unknown>) => (sealStatus = fn),
    setStartSeal: (fn: (input: Row) => Promise<unknown>) => (startSeal = fn),
    advance: (ms: number) => (now += ms),
  };
}

async function manifestFor(uploadId: string, sizeBytes: number) {
  const recipient = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const encryptor = await ChunkedUploadEncryptor.create({
    recipientPublicKey: new Uint8Array(await crypto.subtle.exportKey("raw", recipient.publicKey)),
    ids: { datasetId: "ds1", uploadId },
    plainBytes: sizeBytes,
    chunkBytes: CHUNK,
  });
  const objects: Uint8Array[] = [];
  for (let i = 0; i < encryptor.chunkCount; i++) {
    const size = Math.min(CHUNK, sizeBytes - i * CHUNK);
    objects.push((await encryptor.encrypt(i, new Uint8Array(size).fill(65))).object);
  }
  return { manifest: await encryptor.manifest(), objects };
}

function storeAll(h: ReturnType<typeof harness>, uploadId: string, objects: Uint8Array[], skip: number[] = []) {
  objects.forEach((object, index) => {
    if (!skip.includes(index)) h.stored.set(chunkObjectKey({ datasetId: "ds1", uploadId }, index), object.length);
  });
}

test("ouvrir un envoi découpe le fichier, le reprend, et applique les quotas", async () => {
  const h = harness();
  const opened = await uploads.openDatasetUpload("ds1", PROVIDER, { chunkBytes: CHUNK }, h.deps);
  assert.equal(opened.chunkCount, 4);
  assert.equal(opened.state, "OPEN");
  assert.deepEqual(opened.ingressKey, { publicKey: "ingress" });
  const again = await uploads.openDatasetUpload("ds1", PROVIDER, { chunkBytes: CHUNK }, h.deps);
  assert.equal(again.uploadId, opened.uploadId);

  await assert.rejects(uploads.openDatasetUpload("ds1", PROVIDER, { chunkBytes: 100 }, h.deps), /Taille de morceau invalide/);
  await assert.rejects(uploads.openDatasetUpload("ds1", PROVIDER, { chunkBytes: "8" }, h.deps), /Taille de morceau invalide/);
  await assert.rejects(uploads.openDatasetUpload("ds1", OTHER, {}, h.deps), /autre compte/);

  // Deux envois ouverts au plus par fournisseur.
  await uploads.openDatasetUpload("ds1", PROVIDER, { chunkBytes: 2 * CHUNK }, h.deps);
  await assert.rejects(uploads.openDatasetUpload("ds1", PROVIDER, { chunkBytes: 4 * CHUNK }, h.deps), /Trop d’envois en cours/);
});

test("la taille maximale et la configuration du stockage sont vérifiées avant tout envoi", async () => {
  const saved = process.env.SIRIUS_CHUNKED_MAX_BYTES;
  try {
    delete process.env.SIRIUS_CHUNKED_MAX_BYTES;
    assert.equal(uploads.chunkedUploadMaxBytes(), 16 * 1024 * 1024);
    const big = harness(20 * 1024 * 1024);
    await assert.rejects(uploads.openDatasetUpload("ds1", PROVIDER, {}, big.deps), (error: unknown) => error instanceof AppError && error.status === 413);
    process.env.SIRIUS_CHUNKED_MAX_BYTES = String(1024 * 1024 * 1024);
    assert.equal((await uploads.openDatasetUpload("ds1", PROVIDER, {}, big.deps)).chunkCount, 3);
    process.env.SIRIUS_CHUNKED_MAX_BYTES = String(2 * 1024 * 1024 * 1024);
    assert.throws(() => uploads.chunkedUploadMaxBytes(), /invalide/);
  } finally {
    if (saved === undefined) delete process.env.SIRIUS_CHUNKED_MAX_BYTES;
    else process.env.SIRIUS_CHUNKED_MAX_BYTES = saved;
  }
  assert.throws(
    () => uploads.requireChunkedUploads(10, { storage: () => { throw new Error("Stockage R2 non configuré"); } }),
    (error: unknown) => error instanceof AppError && error.status === 503 && !/R2/.test(error.message),
  );
  // Des morceaux trop petits feraient un manifeste plus gros qu'une requête du runner.
  const many = harness(1024 * CHUNK + 1);
  process.env.SIRIUS_CHUNKED_MAX_BYTES = String(1024 * 1024 * 1024);
  try {
    await assert.rejects(uploads.openDatasetUpload("ds1", PROVIDER, { chunkBytes: CHUNK }, many.deps), /Morceaux trop petits/);
  } finally {
    if (saved === undefined) delete process.env.SIRIUS_CHUNKED_MAX_BYTES;
    else process.env.SIRIUS_CHUNKED_MAX_BYTES = saved;
  }
});

test("les URL d'envoi signent la taille exacte de chaque morceau et gardent le brouillon en vie", async () => {
  const h = harness();
  const { uploadId } = await uploads.openDatasetUpload("ds1", PROVIDER, { chunkBytes: CHUNK }, h.deps);
  h.datasets.rows[0].updatedAt = new Date(0);
  const { parts } = await uploads.presignUploadParts("ds1", uploadId, PROVIDER, [0, 3], h.deps);
  assert.deepEqual(parts.map((part) => part.sizeBytes), [CHUNK + 28, 200_000 - 3 * CHUNK + 28]);
  assert.match(parts[1].url, /chunks\/3\?size=/);
  assert.ok((h.datasets.rows[0].updatedAt as Date).getTime() > 0);

  await assert.rejects(uploads.presignUploadParts("ds1", uploadId, OTHER, [0], h.deps), /autre compte/);
  await assert.rejects(uploads.presignUploadParts("ds2", uploadId, PROVIDER, [0], h.deps), /introuvable/);
  for (const bad of [[], [4], [-1], [0, 0], [1.5], "0", Array.from({ length: 33 }, (_, i) => i)]) {
    await assert.rejects(uploads.presignUploadParts("ds1", uploadId, PROVIDER, bad, h.deps), /Liste de morceaux invalide/);
  }
  h.advance(uploads.UPLOAD_TTL_MS + 1);
  await assert.rejects(uploads.presignUploadParts("ds1", uploadId, PROVIDER, [0], h.deps), (error: unknown) => error instanceof AppError && error.status === 410);
});

test("la clôture exige chaque morceau à sa taille, écrit le manifeste et lance le scellement", async () => {
  const h = harness();
  const { uploadId } = await uploads.openDatasetUpload("ds1", PROVIDER, { chunkBytes: CHUNK }, h.deps);
  const { manifest, objects } = await manifestFor(uploadId, 200_000);

  storeAll(h, uploadId, objects, [1, 2]);
  await assert.rejects(uploads.completeDatasetUpload("ds1", uploadId, PROVIDER, manifest, GRANT, h.deps), /Morceaux manquants : 1, 2/);
  h.stored.set(chunkObjectKey({ datasetId: "ds1", uploadId }, 1), 10);
  h.stored.set(chunkObjectKey({ datasetId: "ds1", uploadId }, 2), objects[2].length);
  await assert.rejects(uploads.completeDatasetUpload("ds1", uploadId, PROVIDER, manifest, GRANT, h.deps), /Morceaux manquants : 1$/);
  storeAll(h, uploadId, objects);

  const status = await uploads.datasetUploadStatus("ds1", uploadId, PROVIDER, h.deps);
  assert.deepEqual("received" in status ? status.received : null, [0, 1, 2, 3]);

  const other = await manifestFor("autre", 200_000);
  await assert.rejects(uploads.completeDatasetUpload("ds1", uploadId, PROVIDER, other.manifest, GRANT, h.deps), /ne correspond pas à cet envoi/);
  const resized: ChunkedUploadManifest = { ...manifest, plainBytes: 199_999 };
  await assert.rejects(uploads.completeDatasetUpload("ds1", uploadId, PROVIDER, resized, GRANT, h.deps), (error: unknown) => error instanceof AppError && error.status === 400);
  await assert.rejects(uploads.completeDatasetUpload("ds1", uploadId, PROVIDER, { nope: true }, GRANT, h.deps), (error: unknown) => error instanceof AppError && error.status === 400);

  // Refus du runner : l'envoi reste ouvert, avec le message.
  h.setStartSeal(async () => {
    throw new AppError("Grant runner hors scope ou expiré", 401);
  });
  await assert.rejects(uploads.completeDatasetUpload("ds1", uploadId, PROVIDER, manifest, GRANT, h.deps), /hors scope/);
  assert.equal(h.datasetUpload.rows[0].state, "OPEN");
  assert.equal(h.datasetUpload.rows[0].error, "Grant runner hors scope ou expiré");

  h.setStartSeal(async (input) => {
    h.calls.started.push(input);
    return { state: "sealing", startedAt: 0 };
  });
  const completed = await uploads.completeDatasetUpload("ds1", uploadId, PROVIDER, manifest, GRANT, h.deps);
  assert.equal(completed.state, "SEALING");
  // Une écriture par tentative de clôture, toujours au même endroit, avec le même contenu.
  assert.deepEqual([...new Set(h.calls.put)], [manifestObjectKey({ datasetId: "ds1", uploadId })]);
  assert.equal(h.datasetUpload.rows[0].manifestSha256, await manifestSha256(manifest));
  const started = h.calls.started[0];
  assert.equal(started.sizeBytes, 200_000);
  assert.equal(started.priceUsdcAtomic, "1000");
  assert.equal(started.authorization, GRANT);
  await assert.rejects(uploads.completeDatasetUpload("ds1", uploadId, PROVIDER, manifest, GRANT, h.deps), /n’attend pas de clôture/);
  await assert.rejects(uploads.abortDatasetUpload("ds1", uploadId, PROVIDER, h.deps), /Scellement en cours/);
});

async function sealingHarness() {
  const h = harness();
  const { uploadId } = await uploads.openDatasetUpload("ds1", PROVIDER, { chunkBytes: CHUNK }, h.deps);
  const { manifest, objects } = await manifestFor(uploadId, 200_000);
  storeAll(h, uploadId, objects);
  await uploads.completeDatasetUpload("ds1", uploadId, PROVIDER, manifest, GRANT, h.deps);
  const sha = await manifestSha256(manifest);
  const result = {
    cid: `sirius-chunked:v1:${uploadId}:${sha}`,
    wrappedKey: "wrapped",
    merkleRoot: "a".repeat(64),
    metrics: { rowCount: 10 },
    sizeBytes: 200_000,
    runnerReceipt: "receipt",
  };
  return { h, uploadId, result };
}

test("un scellement fini pose la référence, la clé enveloppée et le reçu sur le brouillon, une seule fois", async () => {
  const { h, uploadId, result } = await sealingHarness();
  assert.equal((await uploads.datasetUploadStatus("ds1", uploadId, PROVIDER, h.deps)).state, "SEALING");

  h.setSealStatus(async () => ({ state: "sealed", result }));
  assert.equal((await uploads.datasetUploadStatus("ds1", uploadId, PROVIDER, h.deps)).state, "SEALED");
  const dataset = h.datasets.rows[0];
  assert.equal(dataset.ipfsCid, result.cid);
  assert.equal(dataset.wrappedKey, "wrapped");
  assert.equal(dataset.merkleRoot, result.merkleRoot);
  assert.equal(dataset.runnerReceipt, "receipt");
  assert.equal((await uploads.datasetUploadStatus("ds1", uploadId, PROVIDER, h.deps)).state, "SEALED");
  await assert.rejects(uploads.abortDatasetUpload("ds1", uploadId, PROVIDER, h.deps), /déjà scellé/);
});

test("un résultat qui ne correspond pas à l'envoi n'est jamais enregistré", async () => {
  const { h, uploadId, result } = await sealingHarness();
  h.setSealStatus(async () => ({ state: "sealed", result: { ...result, cid: `sirius-chunked:v1:${uploadId}:${"b".repeat(64)}` } }));
  await assert.rejects(uploads.datasetUploadStatus("ds1", uploadId, PROVIDER, h.deps), /incohérent/);
  h.setSealStatus(async () => ({ state: "sealed", result: { ...result, sizeBytes: 1 } }));
  await assert.rejects(uploads.datasetUploadStatus("ds1", uploadId, PROVIDER, h.deps), /incohérent/);
  assert.equal(h.datasets.rows[0].ipfsCid, null);
  assert.equal(h.datasetUpload.rows[0].state, "SEALING");
});

test("un refus de l'enclave clôt l'envoi et supprime ses morceaux ; une panne le rouvre", async () => {
  const refused = await sealingHarness();
  refused.h.setSealStatus(async () => ({ state: "failed", error: "Le dataset doit contenir au moins 100 lignes", status: 400, retryable: false }));
  const failed = await uploads.datasetUploadStatus("ds1", refused.uploadId, PROVIDER, refused.h.deps);
  assert.equal(failed.state, "FAILED");
  assert.equal("error" in failed && failed.error, "Le dataset doit contenir au moins 100 lignes");
  assert.deepEqual(refused.h.calls.deleted, [`datasets/ds1/${refused.uploadId}/`]);
  assert.equal(refused.h.stored.size, 0);

  const retry = await sealingHarness();
  retry.h.setSealStatus(async () => ({ state: "failed", error: "Stockage momentanément injoignable", status: 503, retryable: true }));
  assert.equal((await uploads.datasetUploadStatus("ds1", retry.uploadId, PROVIDER, retry.h.deps)).state, "OPEN");
  assert.equal(retry.h.calls.deleted.length, 0);

  const restarted = await sealingHarness();
  restarted.h.setSealStatus(async () => {
    throw new AppError("Scellement inconnu de ce runner", 404);
  });
  const reopened = await uploads.datasetUploadStatus("ds1", restarted.uploadId, PROVIDER, restarted.h.deps);
  assert.equal(reopened.state, "OPEN");

  const unreachable = await sealingHarness();
  unreachable.h.setSealStatus(async () => {
    throw new AppError("Runner confidentiel indisponible", 503);
  });
  assert.equal((await uploads.datasetUploadStatus("ds1", unreachable.uploadId, PROVIDER, unreachable.h.deps)).state, "SEALING");
});

test("un envoi expiré ou abandonné est fermé et ses morceaux supprimés", async () => {
  const h = harness();
  const { uploadId } = await uploads.openDatasetUpload("ds1", PROVIDER, { chunkBytes: CHUNK }, h.deps);
  const { objects } = await manifestFor(uploadId, 200_000);
  storeAll(h, uploadId, objects);
  assert.equal((await uploads.abortDatasetUpload("ds1", uploadId, PROVIDER, h.deps)).state, "ABORTED");
  assert.equal(h.stored.size, 0);
  await assert.rejects(uploads.presignUploadParts("ds1", uploadId, PROVIDER, [0], h.deps), /n’accepte plus/);

  const second = await uploads.openDatasetUpload("ds1", PROVIDER, { chunkBytes: CHUNK }, h.deps);
  h.advance(uploads.UPLOAD_TTL_MS + 1);
  const expired = await uploads.datasetUploadStatus("ds1", second.uploadId, PROVIDER, h.deps);
  assert.equal(expired.state, "ABORTED");
  assert.equal(h.datasetUpload.rows.find((row) => row.id === second.uploadId)?.state, "ABORTED");
});

test("le reaper supprime les morceaux des envois expirés, puis les ferme ; sans R2, il ne touche à rien", async () => {
  const h = harness();
  const { uploadId } = await uploads.openDatasetUpload("ds1", PROVIDER, { chunkBytes: CHUNK }, h.deps);
  const { objects } = await manifestFor(uploadId, 200_000);
  storeAll(h, uploadId, objects, [2]);
  assert.ok(h.stored.size > 0);

  // Pas encore expiré : rien ne bouge.
  assert.equal(await uploads.purgeExpiredUploads(h.deps), 0);
  assert.equal(h.datasetUpload.rows[0].state, "OPEN");

  h.advance(uploads.UPLOAD_TTL_MS + 1);
  // Sans accès R2 configuré (reaper sans R2_*), rien n'est fermé : les morceaux ne seraient plus suivis.
  assert.equal(await uploads.purgeExpiredUploads({ ...h.deps, storage: () => { throw new Error("R2 non configuré"); } }), 0);
  assert.equal(h.datasetUpload.rows[0].state, "OPEN");

  // Suppression ratée : l'envoi reste ouvert pour la passe suivante.
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  try {
    assert.equal(await uploads.purgeExpiredUploads({ ...h.deps, deletePrefix: async () => { throw new Error("R2 indisponible"); } }), 0);
  } finally {
    console.error = original;
  }
  assert.equal(h.datasetUpload.rows[0].state, "OPEN");
  assert.match(errors.join(" "), /reprise à la passe suivante/);

  assert.equal(await uploads.purgeExpiredUploads(h.deps), 1);
  assert.equal(h.stored.size, 0);
  assert.equal(h.datasetUpload.rows[0].state, "ABORTED");
  assert.equal(h.datasetUpload.rows[0].error, "Envoi expiré");
  assert.equal(await uploads.purgeExpiredUploads(h.deps), 0);
});
