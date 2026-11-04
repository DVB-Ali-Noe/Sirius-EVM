import "server-only";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { AppError } from "@/lib/app-error";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { assertCurrentRunner } from "@/lib/runner/provenance";
import { authorizeDatasetUpload } from "@/lib/sirius/pipeline";
import {
  presignR2Put,
  r2ConfigFromEnv,
  r2DeletePrefix,
  r2ListObjects,
  r2PutObject,
  type R2Config,
} from "@/lib/storage/r2";
import {
  chunkedSealStatusInRunner,
  datasetIngressKeyInRunner,
  startChunkedSealInRunner,
  type ChunkedSealStatus,
} from "@/lib/tee/runner-client";
import {
  MAX_CHUNKED_DATASET_BYTES,
  UPLOAD_CHUNK_BYTES,
  assertChunkBytes,
  canonicalManifestJson,
  chunkCountFor,
  chunkObjectKey,
  chunkPlainBytes,
  manifestObjectKey,
  manifestSha256,
  parseChunkedDatasetCid,
  parseChunkedUploadManifest,
  storedChunkBytes,
  type ChunkedUploadManifest,
  type UploadIds,
} from "@/lib/upload/chunked";

/**
 * Envoi en morceaux d'un gros dataset (docs/UPLOAD-1GO.md, §5 et §7).
 *
 * 1. `openDatasetUpload` ouvre un envoi sur un brouillon (KYB, quota, taille annoncée).
 * 2. `presignUploadParts` donne des URL d'envoi courtes, une par morceau, taille signée.
 * 3. Le navigateur ou la CLI envoie les morceaux chiffrés directement dans R2.
 * 4. `completeDatasetUpload` vérifie le manifeste et la présence des morceaux, l'écrit dans R2 et
 *    demande le scellement à l'enclave avec le grant du fournisseur.
 * 5. `datasetUploadStatus` suit le scellement et, une fois fini, pose sur le brouillon sa
 *    référence, sa clé enveloppée, sa racine et son reçu, comme `completeDatasetIngestion`.
 *
 * Le site ne lit jamais un morceau : il ne voit que des tailles et des empreintes.
 */

export const UPLOAD_TTL_MS = 24 * 60 * 60_000;
export const PART_URL_SECONDS = 15 * 60;
export const MAX_PARTS_PER_REQUEST = 32;
/** Borne le manifeste (~110 octets par morceau) sous les 256 Kio d'une requête de contrôle du runner. */
export const MAX_UPLOAD_CHUNKS = 1024;
/** Corps de la clôture : manifeste de `MAX_UPLOAD_CHUNKS` morceaux, avec de la marge. */
export const MAX_COMPLETE_BODY_BYTES = 192 * 1024;
export const MAX_OPEN_UPLOADS_PER_PROVIDER = 2;
export const DAILY_UPLOAD_BYTES_PER_PROVIDER = 5 * 1024 * 1024 * 1024;
/** Plafond du registre v5 (`MAX_SIZE_BYTES`) : au-delà, le mint serait refusé. Relevé avec le registre v6. */
export const DEFAULT_CHUNKED_MAX_BYTES = 16 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60_000;

export type DatasetUploadState = "OPEN" | "SEALING" | "SEALED" | "FAILED" | "ABORTED";

export interface DatasetUploadRow {
  id: string;
  datasetId: string;
  provider: string;
  sizeBytes: number;
  chunkBytes: number;
  chunkCount: number;
  state: DatasetUploadState;
  manifestSha256: string | null;
  error: string | null;
  expiresAt: Date;
}

export interface ChunkedUploadDeps {
  db: typeof prisma;
  storage: () => R2Config;
  list: typeof r2ListObjects;
  put: typeof r2PutObject;
  deletePrefix: typeof r2DeletePrefix;
  presign: typeof presignR2Put;
  ingressKey: typeof datasetIngressKeyInRunner;
  startSeal: typeof startChunkedSealInRunner;
  sealStatus: typeof chunkedSealStatusInRunner;
  authorize: typeof authorizeDatasetUpload;
  assertRunner: typeof assertCurrentRunner;
  now: () => number;
}

export const defaultChunkedUploadDeps: ChunkedUploadDeps = {
  db: prisma,
  storage: () => r2ConfigFromEnv(),
  list: r2ListObjects,
  put: r2PutObject,
  deletePrefix: r2DeletePrefix,
  presign: presignR2Put,
  ingressKey: datasetIngressKeyInRunner,
  startSeal: startChunkedSealInRunner,
  sealStatus: chunkedSealStatusInRunner,
  authorize: authorizeDatasetUpload,
  assertRunner: assertCurrentRunner,
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------------------------------------------
// Configuration

/** Taille maximale d'un envoi en morceaux sur cette instance (`SIRIUS_CHUNKED_MAX_BYTES`, 1 Gio au plus). */
export function chunkedUploadMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SIRIUS_CHUNKED_MAX_BYTES?.trim();
  if (!raw) return DEFAULT_CHUNKED_MAX_BYTES;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > MAX_CHUNKED_DATASET_BYTES) {
    throw new AppError("SIRIUS_CHUNKED_MAX_BYTES invalide", 503);
  }
  return value;
}

/** Refuse un envoi en morceaux trop gros, ou quand le stockage n'est pas configuré. */
export function requireChunkedUploads(
  sizeBytes: number,
  deps: Pick<ChunkedUploadDeps, "storage"> = defaultChunkedUploadDeps,
  env: Record<string, string | undefined> = process.env,
): R2Config {
  const max = chunkedUploadMaxBytes(env);
  if (sizeBytes > max) {
    throw new AppError(`Fichier trop volumineux pour l’envoi en morceaux (max ${Math.floor(max / (1024 * 1024))} Mo)`, 413);
  }
  try {
    return deps.storage();
  } catch {
    throw new AppError("Envoi des gros fichiers indisponible pour l’instant", 503);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Lecture

function publicUpload(upload: DatasetUploadRow) {
  return {
    uploadId: upload.id,
    datasetId: upload.datasetId,
    state: upload.state,
    sizeBytes: upload.sizeBytes,
    chunkBytes: upload.chunkBytes,
    chunkCount: upload.chunkCount,
    expiresAt: upload.expiresAt.toISOString(),
    ...(upload.error ? { error: upload.error } : {}),
  };
}

function idsOf(upload: DatasetUploadRow): UploadIds {
  return { datasetId: upload.datasetId, uploadId: upload.id };
}

function chunksPrefix(ids: UploadIds): string {
  return chunkObjectKey(ids, 0).replace(/0$/, "");
}

function uploadPrefix(ids: UploadIds): string {
  return manifestObjectKey(ids).replace(/manifest\.json$/, "");
}

async function loadUpload(deps: ChunkedUploadDeps, datasetId: string, uploadId: string, provider: string): Promise<DatasetUploadRow> {
  const upload = (await deps.db.datasetUpload.findUnique({ where: { id: uploadId } })) as DatasetUploadRow | null;
  if (!upload || upload.datasetId !== datasetId) throw new AppError("Envoi introuvable", 404);
  if (upload.provider !== provider) throw new AppError("Accès refusé : ressource d’un autre compte", 403);
  return upload;
}

/** Morceaux déjà reçus par R2 avec la bonne taille ; un morceau tronqué compte comme absent. */
async function receivedChunks(deps: ChunkedUploadDeps, config: R2Config, upload: DatasetUploadRow): Promise<number[]> {
  const ids = idsOf(upload);
  const prefix = chunksPrefix(ids);
  const received = new Set<number>();
  for (const { key, size } of await deps.list(config, prefix)) {
    const suffix = key.slice(prefix.length);
    if (!/^(0|[1-9]\d{0,5})$/.test(suffix)) continue;
    const index = Number(suffix);
    if (index >= upload.chunkCount) continue;
    if (size === storedChunkBytes(chunkPlainBytes(index, upload.sizeBytes, upload.chunkBytes))) received.add(index);
  }
  return [...received].sort((a, b) => a - b);
}

async function abortUpload(deps: ChunkedUploadDeps, upload: DatasetUploadRow, from: DatasetUploadState[], error?: string): Promise<void> {
  await deps.db.datasetUpload.updateMany({
    where: { id: upload.id, state: { in: from } },
    data: { state: "ABORTED", ...(error ? { error } : {}) },
  });
  await deps.deletePrefix(deps.storage(), uploadPrefix(idsOf(upload))).catch(() =>
    console.error(`Nettoyage R2 impossible pour l’envoi ${upload.id}`),
  );
}

/** Rafraîchit le brouillon : sinon le nettoyage des brouillons abandonnés (30 min) le supprimerait en plein envoi. */
async function touchDraft(deps: ChunkedUploadDeps, upload: DatasetUploadRow): Promise<void> {
  await deps.db.dataset.updateMany({
    where: { id: upload.datasetId, provider: upload.provider, status: "DRAFT", ipfsCid: null },
    data: { updatedAt: new Date(deps.now()) },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Ouverture

export async function openDatasetUpload(
  datasetId: string,
  provider: string,
  options: { chunkBytes?: unknown } = {},
  deps: ChunkedUploadDeps = defaultChunkedUploadDeps,
) {
  const chunkBytes = options.chunkBytes ?? UPLOAD_CHUNK_BYTES;
  if (typeof chunkBytes !== "number") throw new AppError("Taille de morceau invalide", 400);
  try {
    assertChunkBytes(chunkBytes);
  } catch {
    throw new AppError("Taille de morceau invalide", 400);
  }
  const dataset = await deps.authorize(datasetId, provider);
  requireChunkedUploads(dataset.sizeBytes, deps);
  if (chunkCountFor(dataset.sizeBytes, chunkBytes) > MAX_UPLOAD_CHUNKS) {
    throw new AppError("Morceaux trop petits pour ce fichier", 400);
  }

  const now = deps.now();
  const existing = (await deps.db.datasetUpload.findFirst({
    where: { datasetId, provider, state: "OPEN", expiresAt: { gt: new Date(now) } },
    orderBy: { createdAt: "desc" },
  })) as DatasetUploadRow | null;
  // Reprise : le même brouillon garde son envoi ouvert, les morceaux déjà reçus restent valables.
  if (existing && existing.chunkBytes === chunkBytes && existing.sizeBytes === dataset.sizeBytes) {
    return { ...publicUpload(existing), ingressKey: await deps.ingressKey() };
  }

  const [open, recent] = await Promise.all([
    deps.db.datasetUpload.count({ where: { provider, state: { in: ["OPEN", "SEALING"] }, expiresAt: { gt: new Date(now) } } }),
    deps.db.datasetUpload.aggregate({ where: { provider, createdAt: { gte: new Date(now - DAY_MS) } }, _sum: { sizeBytes: true } }),
  ]);
  if (open >= MAX_OPEN_UPLOADS_PER_PROVIDER) throw new AppError("Trop d’envois en cours : termine ou annule un envoi", 429);
  if ((recent._sum.sizeBytes ?? 0) + dataset.sizeBytes > DAILY_UPLOAD_BYTES_PER_PROVIDER) {
    throw new AppError("Quota d’envoi du jour atteint — réessaie demain", 429);
  }
  const upload = (await deps.db.datasetUpload.create({
    data: {
      datasetId,
      provider,
      sizeBytes: dataset.sizeBytes,
      chunkBytes,
      chunkCount: chunkCountFor(dataset.sizeBytes, chunkBytes),
      expiresAt: new Date(now + UPLOAD_TTL_MS),
    },
  })) as DatasetUploadRow;
  return { ...publicUpload(upload), ingressKey: await deps.ingressKey() };
}

// ---------------------------------------------------------------------------------------------------------------
// 2. URL d'envoi

function partIndexes(value: unknown, chunkCount: number): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PARTS_PER_REQUEST) {
    throw new AppError(`Liste de morceaux invalide (1 à ${MAX_PARTS_PER_REQUEST})`, 400);
  }
  const unique = new Set<number>();
  for (const index of value) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= chunkCount || unique.has(index)) {
      throw new AppError("Liste de morceaux invalide", 400);
    }
    unique.add(index);
  }
  return [...unique];
}

export async function presignUploadParts(
  datasetId: string,
  uploadId: string,
  provider: string,
  indexes: unknown,
  deps: ChunkedUploadDeps = defaultChunkedUploadDeps,
) {
  const upload = await loadUpload(deps, datasetId, uploadId, provider);
  if (upload.state !== "OPEN") throw new AppError("Cet envoi n’accepte plus de morceaux", 409);
  if (upload.expiresAt.getTime() <= deps.now()) throw new AppError("Envoi expiré : recommence l’envoi", 410);
  const wanted = partIndexes(indexes, upload.chunkCount);
  const config = requireChunkedUploads(upload.sizeBytes, deps);
  await touchDraft(deps, upload);
  const ids = idsOf(upload);
  const now = new Date(deps.now());
  return {
    expiresAt: new Date(now.getTime() + PART_URL_SECONDS * 1000).toISOString(),
    parts: wanted.map((index) => {
      const sizeBytes = storedChunkBytes(chunkPlainBytes(index, upload.sizeBytes, upload.chunkBytes));
      return { index, sizeBytes, url: deps.presign(config, chunkObjectKey(ids, index), PART_URL_SECONDS, undefined, now, sizeBytes) };
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Clôture

function missingMessage(missing: number[]): string {
  const shown = missing.slice(0, 10).join(", ");
  return `Morceaux manquants : ${shown}${missing.length > 10 ? "…" : ""}`;
}

export async function completeDatasetUpload(
  datasetId: string,
  uploadId: string,
  provider: string,
  manifestValue: unknown,
  authorization: RunnerGrant,
  deps: ChunkedUploadDeps = defaultChunkedUploadDeps,
) {
  const upload = await loadUpload(deps, datasetId, uploadId, provider);
  if (upload.state !== "OPEN") throw new AppError("Cet envoi n’attend pas de clôture", 409);
  if (upload.expiresAt.getTime() <= deps.now()) throw new AppError("Envoi expiré : recommence l’envoi", 410);
  const dataset = await deps.authorize(datasetId, provider);
  if (dataset.sizeBytes !== upload.sizeBytes) throw new AppError("La taille du fichier ne correspond pas au dépôt", 400);
  const config = requireChunkedUploads(upload.sizeBytes, deps);

  let manifest: ChunkedUploadManifest;
  try {
    manifest = await parseChunkedUploadManifest(manifestValue);
  } catch (error) {
    throw new AppError((error as Error).message, 400);
  }
  if (manifest.datasetId !== datasetId || manifest.uploadId !== uploadId) {
    throw new AppError("Le manifeste ne correspond pas à cet envoi", 400);
  }
  if (manifest.plainBytes !== upload.sizeBytes || manifest.chunkBytes !== upload.chunkBytes || manifest.chunkCount !== upload.chunkCount) {
    throw new AppError("Le manifeste ne correspond pas à la taille annoncée", 400);
  }
  const received = new Set(await receivedChunks(deps, config, upload));
  const missing = Array.from({ length: upload.chunkCount }, (_, index) => index).filter((index) => !received.has(index));
  if (missing.length > 0) throw new AppError(missingMessage(missing), 409);

  const sha = await manifestSha256(manifest);
  await deps.put(config, manifestObjectKey(idsOf(upload)), new Uint8Array(new TextEncoder().encode(canonicalManifestJson(manifest))));
  const claimed = await deps.db.datasetUpload.updateMany({
    where: { id: upload.id, state: "OPEN" },
    data: { state: "SEALING", manifestSha256: sha, error: null },
  });
  if (claimed.count !== 1) throw new AppError("Envoi déjà clôturé", 409);

  try {
    await deps.startSeal({
      datasetId,
      uploadId,
      priceUsdcAtomic: dataset.priceUsdcAtomic,
      challengeDays: dataset.challengeDays,
      maxRentalDays: dataset.maxRentalDays,
      sizeBytes: dataset.sizeBytes,
      manifest,
      authorization,
      model: dataset.model,
    });
  } catch (error) {
    // Refus de l'enclave (manifeste, grant) : l'envoi reste ouvert, le fournisseur corrige et
    // relance avec un nouveau grant. Les morceaux reçus restent valables.
    const message = error instanceof AppError ? error.message : "Runner confidentiel indisponible";
    await deps.db.datasetUpload.updateMany({ where: { id: upload.id, state: "SEALING" }, data: { state: "OPEN", error: message } });
    throw error;
  }
  return { ...publicUpload({ ...upload, state: "SEALING", manifestSha256: sha, error: null }) };
}

// ---------------------------------------------------------------------------------------------------------------
// 4. Suivi et finalisation

async function finalizeSealed(
  deps: ChunkedUploadDeps,
  upload: DatasetUploadRow,
  result: Extract<ChunkedSealStatus, { state: "sealed" }>["result"],
): Promise<void> {
  const reference = parseChunkedDatasetCid(result.cid);
  if (!reference || reference.uploadId !== upload.id || reference.manifestSha !== upload.manifestSha256 || result.sizeBytes !== upload.sizeBytes) {
    throw new AppError("Scellement incohérent avec cet envoi", 502);
  }
  const dataset = await deps.db.dataset.findUnique({
    where: { id: upload.datasetId },
    select: { runnerKind: true, runnerDeploymentId: true },
  });
  if (!dataset) throw new AppError("Dataset introuvable", 404);
  await deps.assertRunner(dataset);
  await deps.db.$transaction(async (tx) => {
    const claimed = await tx.datasetUpload.updateMany({ where: { id: upload.id, state: "SEALING" }, data: { state: "SEALED", error: null } });
    if (claimed.count !== 1) return;
    const written = await tx.dataset.updateMany({
      where: { id: upload.datasetId, provider: upload.provider, status: "DRAFT", ipfsCid: null, wrappedKey: null, keyDestroyedAt: null },
      data: {
        ipfsCid: result.cid,
        wrappedKey: result.wrappedKey,
        merkleRoot: result.merkleRoot,
        metrics: result.metrics as unknown as Prisma.InputJsonValue,
        runnerReceipt: result.runnerReceipt,
      },
    });
    if (written.count !== 1) throw new AppError("Le dataset a changé pendant le scellement", 409);
  });
}

export async function datasetUploadStatus(
  datasetId: string,
  uploadId: string,
  provider: string,
  deps: ChunkedUploadDeps = defaultChunkedUploadDeps,
) {
  let upload = await loadUpload(deps, datasetId, uploadId, provider);

  if (upload.state === "OPEN") {
    if (upload.expiresAt.getTime() <= deps.now()) {
      await abortUpload(deps, upload, ["OPEN"], "Envoi expiré");
      return publicUpload({ ...upload, state: "ABORTED", error: "Envoi expiré" });
    }
    const config = requireChunkedUploads(upload.sizeBytes, deps);
    return { ...publicUpload(upload), received: await receivedChunks(deps, config, upload) };
  }
  if (upload.state !== "SEALING") return publicUpload(upload);

  let status: ChunkedSealStatus;
  try {
    status = await deps.sealStatus(datasetId, uploadId);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) {
      // Runner redémarré : le scellement est perdu, les morceaux non. Nouvelle clôture possible.
      const message = "Scellement interrompu : relance la clôture";
      await deps.db.datasetUpload.updateMany({ where: { id: upload.id, state: "SEALING" }, data: { state: "OPEN", error: message } });
      return { ...publicUpload({ ...upload, state: "OPEN", error: message }) };
    }
    // Runner momentanément injoignable : on garde l'état et on réessaiera au prochain suivi.
    return publicUpload(upload);
  }

  if (status.state === "sealing") return publicUpload(upload);
  if (status.state === "sealed") {
    await finalizeSealed(deps, upload, status.result);
  } else if (status.retryable) {
    await deps.db.datasetUpload.updateMany({ where: { id: upload.id, state: "SEALING" }, data: { state: "OPEN", error: status.error } });
  } else {
    // Fichier refusé (format, profil, empreintes) : les morceaux ne serviront plus.
    await deps.db.datasetUpload.updateMany({ where: { id: upload.id, state: "SEALING" }, data: { state: "FAILED", error: status.error } });
    await deps.deletePrefix(deps.storage(), uploadPrefix(idsOf(upload))).catch(() =>
      console.error(`Nettoyage R2 impossible pour l’envoi ${upload.id}`),
    );
  }
  upload = await loadUpload(deps, datasetId, uploadId, provider);
  return publicUpload(upload);
}

// ---------------------------------------------------------------------------------------------------------------
// 5. Abandon

export async function abortDatasetUpload(
  datasetId: string,
  uploadId: string,
  provider: string,
  deps: ChunkedUploadDeps = defaultChunkedUploadDeps,
) {
  const upload = await loadUpload(deps, datasetId, uploadId, provider);
  if (upload.state === "SEALING") throw new AppError("Scellement en cours : attends sa fin", 409);
  if (upload.state === "SEALED") throw new AppError("Envoi déjà scellé", 409);
  if (upload.state !== "ABORTED") await abortUpload(deps, upload, ["OPEN", "FAILED"]);
  return publicUpload({ ...upload, state: "ABORTED" });
}
