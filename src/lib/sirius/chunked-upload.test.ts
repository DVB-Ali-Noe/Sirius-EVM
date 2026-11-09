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

/** Filtre Prisma minimal : égalité, `in`, `gt`, `gte`, `lte`, `not`, `OR`, relation `dataset`. */
function matches(row: Row, where: Row, relation?: (row: Row) => Row | undefined): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Row[]).some((branch) => matches(row, branch, relation));
    if (key === "dataset") {
      const parent = relation?.(row);
      return parent !== undefined && matches(parent, condition as Row);
    }
    const value = row[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const c = condition as { in?: unknown[]; gt?: Date; gte?: Date; lte?: Date; not?: unknown };
      if (c.in && !c.in.includes(value)) return false;
      if (c.gt && !((value as Date) > c.gt)) return false;
      if (c.gte && !((value as Date) >= c.gte)) return false;
      if (c.lte && !((value as Date) <= c.lte)) return false;
      if ("not" in c && value === c.not) return false;
      return true;
    }
    return value === condition;
  });
}

/** Table simulée ; `clock` date `createdAt`/`updatedAt` comme `@default(now())`/`@updatedAt`. */
function table(rows: Row[], clock: () => number = Date.now, relation?: (row: Row) => Row | undefined) {
  const hit = (where: Row) => rows.filter((row) => matches(row, where, relation));
  return {
    rows,
    async findUnique({ where }: { where: Row }) {
      return hit(where)[0] ?? null;
    },
    async findMany({ where, take }: { where: Row; take?: number }) {
      return hit(where).slice(0, take ?? rows.length);
    },
    async findFirst({ where }: { where: Row }) {
      return hit(where).at(-1) ?? null;
    },
    async count({ where }: { where: Row }) {
      return hit(where).length;
    },
    async aggregate({ where }: { where: Row }) {
      return { _sum: { sizeBytes: hit(where).reduce((sum, row) => sum + Number(row.sizeBytes), 0) || null } };
    },
    async create({ data }: { data: Row }) {
      const at = new Date(clock());
      const row = { id: `upload${rows.length + 1}`, state: "OPEN", manifestSha256: null, error: null, purgedAt: null, createdAt: at, updatedAt: at, ...data };
      rows.push(row);
      return row;
    },
    async updateMany({ where, data }: { where: Row; data: Row }) {
      const matched = hit(where);
      for (const row of matched) Object.assign(row, { updatedAt: new Date(clock()) }, data);
      return { count: matched.length };
    },
  };
}

function harness(sizeBytes = 200_000) {
  let now = Date.UTC(2026, 10, 4);
  const clock = () => now;
  const datasets = table([
    { id: "ds1", provider: PROVIDER, status: "DRAFT", ipfsCid: null, wrappedKey: null, keyDestroyedAt: null, runnerKind: "DEVELOPMENT", runnerDeploymentId: null },
  ], clock);
  const datasetUpload = table([], clock, (upload) => datasets.rows.find((dataset) => dataset.id === upload.datasetId));
  const db = { dataset: datasets, datasetUpload, $transaction: async (action: (tx: unknown) => Promise<unknown>) => action(db) };
  // Transaction sérialisable : une seule à la fois, comme Postgres le garantit pour l'issue de deux
  // transactions concurrentes (l'une échoue et rejoue après l'autre).
  let serial: Promise<unknown> = Promise.resolve();
  const serializable = (action: (tx: unknown) => Promise<unknown>) => {
    const run = serial.then(() => action(db));
    serial = run.catch(() => undefined);
    return run;
  };
  const stored = new Map<string, number>();
  const calls = { started: [] as Row[], presigned: [] as string[], deleted: [] as string[], put: [] as string[], wakes: 0 };
  let sealStatus: () => Promise<unknown> = async () => ({ state: "sealing", startedAt: 0 });
  let startSeal: (input: Row) => Promise<unknown> = async (input) => {
    calls.started.push(input);
    return { state: "sealing", startedAt: 0 };
  };
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
    // Comme `authorizeDatasetUpload` : contrôles du brouillon, `validate` de la route, puis réveil.
    authorize: async (id: string, provider: string, validate?: (terms: Row & { sizeBytes: number }) => Promise<void> | void) => {
      if (provider !== PROVIDER) throw new AppError("Accès refusé : ressource d’un autre compte", 403);
      const terms = { id, provider, sizeBytes, priceUsdcAtomic: "1000", challengeDays: 7, maxRentalDays: 30, model: { modelId: "linear_regression", modelVersion: "1.0.0" } };
      await validate?.(terms);
      calls.wakes++;
      return { ...terms, runnerKind: "DEVELOPMENT", runnerDeploymentId: null };
    },
    assertRunner: async () => ({}),
    now: () => now,
    serializable,
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
    assert.equal(many.calls.wakes, 0, "un découpage invalide ne réveille pas la CVM");
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
  const wakesBefore = h.calls.wakes;
  await assert.rejects(uploads.completeDatasetUpload("ds1", uploadId, PROVIDER, manifest, GRANT, h.deps), /Morceaux manquants : 1, 2/);
  await assert.rejects(uploads.completeDatasetUpload("ds1", uploadId, PROVIDER, { ...manifest, chunkCount: 99 }, GRANT, h.deps), (error: unknown) => error instanceof AppError && error.status === 400);
  assert.equal(h.calls.wakes, wakesBefore, "manifeste invalide ou morceaux manquants : aucun réveil");
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

/** Erreurs console capturées pendant `action` (suppressions R2 ratées attendues). */
async function quietErrors(action: () => Promise<unknown>): Promise<string> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  try {
    await action();
  } finally {
    console.error = original;
  }
  return errors.join(" ");
}

const failingDelete = async () => {
  throw new Error("R2 indisponible");
};

test("le reaper supprime les morceaux des envois expirés, puis les ferme ; sans R2, il ne touche à rien", async () => {
  const h = harness();
  const { uploadId } = await uploads.openDatasetUpload("ds1", PROVIDER, { chunkBytes: CHUNK }, h.deps);
  const { objects } = await manifestFor(uploadId, 200_000);
  storeAll(h, uploadId, objects, [2]);
  assert.ok(h.stored.size > 0);

  // Pas encore expiré : rien ne bouge.
  assert.equal(await uploads.purgeExpiredUploads(h.deps), 0);
  assert.equal(h.datasetUpload.rows[0].state, "OPEN");

  // Échu, mais une URL signée juste avant l'échéance peut encore servir 15 min : on attend.
  h.advance(uploads.UPLOAD_TTL_MS + 1);
  assert.equal(await uploads.purgeExpiredUploads(h.deps), 0);
  assert.equal(h.datasetUpload.rows[0].state, "OPEN");

  h.advance(uploads.PART_URL_SECONDS * 1000);
  // Sans accès R2 configuré (reaper sans R2_*), rien n'est fermé : les morceaux ne seraient plus suivis.
  assert.equal(await uploads.purgeExpiredUploads({ ...h.deps, storage: () => { throw new Error("R2 non configuré"); } }), 0);
  assert.equal(h.datasetUpload.rows[0].state, "OPEN");

  // Suppression ratée : l'envoi est fermé mais pas marqué purgé ; une passe suivante réessaie.
  const errors = await quietErrors(async () => assert.equal(await uploads.purgeExpiredUploads({ ...h.deps, deletePrefix: failingDelete }), 0));
  assert.equal(h.datasetUpload.rows[0].state, "ABORTED");
  assert.equal(String(h.datasetUpload.rows[0].purgedAt), "null");
  assert.ok(h.stored.size > 0);
  assert.match(errors, /reprise à une passe suivante/);

  h.advance(uploads.PART_URL_SECONDS * 1000);
  assert.equal(await uploads.purgeExpiredUploads(h.deps), 1);
  assert.equal(h.stored.size, 0);
  assert.equal(h.datasetUpload.rows[0].state, "ABORTED");
  assert.equal(h.datasetUpload.rows[0].error, "Envoi expiré");
  assert.ok(h.datasetUpload.rows[0].purgedAt instanceof Date);
  assert.equal(await uploads.purgeExpiredUploads(h.deps), 0);
});

test("le reaper laisse finir un scellement lancé juste avant l'échéance et ne touche pas un envoi scellé entre-temps", async () => {
  const h = harness();
  const { uploadId } = await uploads.openDatasetUpload("ds1", PROVIDER, { chunkBytes: CHUNK }, h.deps);
  const { manifest, objects } = await manifestFor(uploadId, 200_000);
  storeAll(h, uploadId, objects);
  h.advance(uploads.UPLOAD_TTL_MS - 60_000);
  await uploads.completeDatasetUpload("ds1", uploadId, PROVIDER, manifest, GRANT, h.deps);
  const row = h.datasetUpload.rows[0];
  const stored = h.stored.size;

  // Échéance et URL signées passées, mais le scellement a 17 min : il continue avec ses morceaux.
  h.advance(17 * 60_000);
  assert.equal(await uploads.purgeExpiredUploads(h.deps), 0);
  assert.equal(row.state, "SEALING");
  assert.equal(h.stored.size, stored);

  // Scellement bloqué depuis plus d'une heure, mais qui finit pendant la passe du reaper.
  h.advance(60 * 60_000);
  const findMany = h.datasetUpload.findMany;
  h.datasetUpload.findMany = async (args) => {
    const due = (await findMany(args)).map((upload) => ({ ...upload }));
    row.state = "SEALED";
    return due;
  };
  assert.equal(await uploads.purgeExpiredUploads(h.deps), 0);
  h.datasetUpload.findMany = findMany;
  assert.equal(row.state, "SEALED");
  assert.equal(h.stored.size, stored, "un envoi scellé garde ses morceaux");

  // Bloqué pour de bon : purgé, et un résultat tardif du runner ne pose plus rien sur le brouillon.
  row.state = "SEALING";
  assert.equal(await uploads.purgeExpiredUploads(h.deps), 1);
  assert.equal(row.state, "ABORTED");
  assert.equal(h.stored.size, 0);
  assert.equal((await uploads.datasetUploadStatus("ds1", uploadId, PROVIDER, h.deps)).state, "ABORTED");
  assert.equal(h.datasets.rows[0].ipfsCid, null);
});

test("un envoi abandonné ou refusé est repurgé après l'expiration des URL signées, même si sa suppression avait échoué", async () => {
  const h = harness();
  const { uploadId } = await uploads.openDatasetUpload("ds1", PROVIDER, { chunkBytes: CHUNK }, h.deps);
  const { objects } = await manifestFor(uploadId, 200_000);
  storeAll(h, uploadId, objects);
  await quietErrors(() => uploads.abortDatasetUpload("ds1", uploadId, PROVIDER, { ...h.deps, deletePrefix: failingDelete }));
  assert.equal(h.datasetUpload.rows[0].state, "ABORTED");
  assert.equal(h.stored.size, objects.length, "première suppression ratée");

  // Refusé par l'enclave, nettoyé tout de suite… puis un PUT signé avant le refus arrive encore.
  const refused = await sealingHarness();
  refused.h.setSealStatus(async () => ({ state: "failed", error: "Le dataset doit contenir au moins 100 lignes", status: 400, retryable: false }));
  await uploads.datasetUploadStatus("ds1", refused.uploadId, PROVIDER, refused.h.deps);
  assert.equal(refused.h.stored.size, 0);
  refused.h.stored.set(chunkObjectKey({ datasetId: "ds1", uploadId: refused.uploadId }, 3), 100);

  for (const { deps } of [h, refused.h]) {
    assert.equal(await uploads.purgeExpiredUploads(deps), 0, "URL encore valables : on attend");
  }
  h.advance(uploads.PART_URL_SECONDS * 1000);
  refused.h.advance(uploads.PART_URL_SECONDS * 1000);
  for (const { deps, stored, datasetUpload } of [h, refused.h]) {
    assert.equal(await uploads.purgeExpiredUploads(deps), 1);
    assert.equal(stored.size, 0);
    assert.ok(datasetUpload.rows[0].purgedAt instanceof Date);
    assert.equal(await uploads.purgeExpiredUploads(deps), 0, "purgé une fois pour toutes");
  }
  assert.equal(h.datasetUpload.rows[0].state, "ABORTED");
  assert.equal(refused.h.datasetUpload.rows[0].state, "FAILED");
});

test("supprimer un gros dataset efface ses morceaux et son manifeste de R2 ; le reaper reprend une suppression ratée", async () => {
  const sealed = async () => {
    const { h, uploadId, result } = await sealingHarness();
    h.setSealStatus(async () => ({ state: "sealed", result }));
    assert.equal((await uploads.datasetUploadStatus("ds1", uploadId, PROVIDER, h.deps)).state, "SEALED");
    assert.ok(h.stored.has(manifestObjectKey({ datasetId: "ds1", uploadId })));
    // `deleteDataset` : clé enveloppée effacée, dataset DELETED.
    Object.assign(h.datasets.rows[0], { status: "DELETED", wrappedKey: null });
    return h;
  };

  const h = await sealed();
  await uploads.purgeDeletedDatasetUploads("ds1", h.deps);
  assert.equal(h.stored.size, 0, "plus de manifeste : la clé d'envoi ne se recalcule plus");
  assert.equal(h.datasetUpload.rows[0].state, "ABORTED");
  assert.equal(h.datasetUpload.rows[0].error, "Dataset supprimé");

  // R2 indisponible au moment de la suppression : le reaper repasse.
  const retried = await sealed();
  await quietErrors(() => uploads.purgeDeletedDatasetUploads("ds1", { ...retried.deps, deletePrefix: failingDelete }));
  assert.ok(retried.stored.size > 0);
  retried.advance(uploads.PART_URL_SECONDS * 1000);
  assert.equal(await uploads.purgeExpiredUploads(retried.deps), 1);
  assert.equal(retried.stored.size, 0);

  // Base indisponible au moment de la suppression : l'envoi resté SEALED d'un dataset supprimé est purgé aussi.
  const stuck = await sealed();
  assert.equal(await uploads.purgeExpiredUploads(stuck.deps), 1);
  assert.equal(stuck.stored.size, 0);
  assert.equal(stuck.datasetUpload.rows[0].state, "ABORTED");
  assert.equal(stuck.datasetUpload.rows[0].error, "Dataset supprimé");

  // Un dataset scellé et toujours publié garde évidemment ses morceaux.
  const live = await sealed();
  live.datasets.rows[0].status = "LISTED";
  live.advance(uploads.UPLOAD_TTL_MS * 2);
  assert.equal(await uploads.purgeExpiredUploads(live.deps), 0);
  assert.ok(live.stored.size > 0);
});

test("deux ouvertures simultanées ne dépassent pas le nombre d'envois en cours du fournisseur", async () => {
  const h = harness();
  await uploads.openDatasetUpload("ds1", PROVIDER, { chunkBytes: CHUNK }, h.deps);
  const results = await Promise.allSettled([
    uploads.openDatasetUpload("ds2", PROVIDER, { chunkBytes: CHUNK }, h.deps),
    uploads.openDatasetUpload("ds3", PROVIDER, { chunkBytes: CHUNK }, h.deps),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.match(String(rejected?.reason), /Trop d’envois en cours/);
  assert.equal(h.datasetUpload.rows.length, uploads.MAX_OPEN_UPLOADS_PER_PROVIDER);
});
