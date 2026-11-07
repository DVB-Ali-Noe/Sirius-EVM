import { createHash } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { MAX_CSV_ROWS, parseCsv } from "@/lib/sirius/metrics";
import { r2ConfigFromEnv, r2GetObject } from "@/lib/storage/r2";
import { RunnerRetryLater } from "@/lib/runner/failure-policy";
import { StrictCsvStream } from "@/lib/upload/csv-stream";
import {
  chunkObjectKey,
  decryptChunk,
  manifestObjectKey,
  manifestSha256,
  parseChunkedDatasetCid,
  parseChunkedUploadManifest,
  type ChunkedUploadManifest,
  type UploadIds,
} from "@/lib/upload/chunked";
import { MAX_DATASET_BYTES } from "./contract";

/**
 * Échantillon d'entraînement d'un gros dataset (envoi en morceaux, docs/UPLOAD-1GO.md §9).
 *
 * Relire 1 Gio dépasse le délai d'une requête du runner : en attendant l'entraînement complet en
 * arrière-plan, les modèles d'un gros dataset sont entraînés sur un échantillon dans les limites
 * des petits fichiers (3 Mio, 49 999 lignes). L'échantillon est déterministe (le même fichier
 * donne toujours les mêmes lignes) : des lignes entières prises dans des morceaux répartis sur tout
 * le fichier (8 morceaux de 8 Mio), pas seulement son début, pour ne pas suivre un fichier trié par
 * date. Un fichier qui tient dans ces limites est pris en entier.
 *
 * Intégrité : la référence publiée s'engage sur l'empreinte du manifeste, le manifeste sur chaque
 * morceau stocké et sur la racine du clair scellée. Chaque morceau lu est comparé au manifeste
 * avant déchiffrement ; l'AES-GCM lie en plus son contenu à sa place dans le fichier.
 */

export const SAMPLE_CHUNKS = 8;
const MAX_SAMPLE_CHUNKS = 64;
export const SAMPLE_MAX_BYTES = MAX_DATASET_BYTES;
/** `parseCsv` compte l'en-tête dans sa limite de lignes. */
export const SAMPLE_MAX_ROWS = MAX_CSV_ROWS - 1;
const HEADER_MARGIN_BYTES = 1024;

export interface ChunkedSampleSource {
  readManifest(): Promise<Uint8Array>;
  readChunk(index: number): Promise<Uint8Array<ArrayBuffer>>;
}

export interface ChunkedSampleRef {
  datasetId: string;
  cid: string;
  merkleRoot: string;
}

/** Indices répartis régulièrement, le premier morceau (en-tête) et le dernier compris. */
export function sampleChunkIndexes(chunkCount: number, wanted = SAMPLE_CHUNKS): number[] {
  if (chunkCount <= wanted) return Array.from({ length: chunkCount }, (_, index) => index);
  const indexes = new Set<number>();
  for (let i = 0; i < wanted; i++) indexes.add(Math.round((i * (chunkCount - 1)) / (wanted - 1)));
  return [...indexes].sort((a, b) => a - b);
}

function integrityError(datasetId: string): Error {
  return new Error(`Intégrité Merkle invalide pour ${datasetId}`);
}

async function verifiedManifest(ref: ChunkedSampleRef, source: ChunkedSampleSource): Promise<ChunkedUploadManifest> {
  const reference = parseChunkedDatasetCid(ref.cid);
  if (!reference) throw integrityError(ref.datasetId);
  let manifest: ChunkedUploadManifest;
  try {
    manifest = await parseChunkedUploadManifest(JSON.parse(new TextDecoder().decode(await source.readManifest())));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw integrityError(ref.datasetId);
  }
  if (
    (await manifestSha256(manifest)) !== reference.manifestSha ||
    manifest.datasetId !== ref.datasetId ||
    manifest.uploadId !== reference.uploadId ||
    manifest.plaintextRoot !== ref.merkleRoot
  ) {
    throw integrityError(ref.datasetId);
  }
  return manifest;
}

function quoteField(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

/**
 * Échantillon de secours : les premières lignes du fichier, lues avec le lecteur strict. Sert
 * quand un fichier contient des retours à la ligne entre guillemets, que le découpage par lignes
 * des morceaux du milieu ne saurait pas resynchroniser.
 */
async function prefixSample(manifest: ChunkedUploadManifest, chunk: (index: number) => Promise<Uint8Array<ArrayBuffer>>): Promise<Buffer> {
  const lines: string[] = [];
  let bytes = 0;
  let full = false;
  const csv = new StrictCsvStream((row, header) => {
    if (full) return;
    if (lines.length === 0) {
      const head = header.map(quoteField).join(",");
      lines.push(head);
      bytes += head.length + 1;
    }
    const line = row.map(quoteField).join(",");
    if (lines.length - 1 >= SAMPLE_MAX_ROWS || bytes + line.length + 1 > SAMPLE_MAX_BYTES) {
      full = true;
      return;
    }
    lines.push(line);
    bytes += line.length + 1;
  });
  for (let index = 0; index < manifest.chunkCount && !full; index++) csv.pushBytes(await chunk(index));
  if (!full) csv.end();
  return Buffer.from(`${lines.join("\n")}\n`);
}

/** Lignes entières d'un morceau : sans la ligne coupée au début (sauf le premier) ni à la fin (sauf le dernier). */
function completeLines(text: string, first: boolean, last: boolean): string[] {
  let body = text;
  if (!first) {
    const start = body.indexOf("\n");
    body = start < 0 ? "" : body.slice(start + 1);
  }
  if (!last) {
    const end = body.lastIndexOf("\n");
    body = end < 0 ? "" : body.slice(0, end);
  }
  return body.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

export async function chunkedTrainingSample(
  ref: ChunkedSampleRef,
  uploadKey: Buffer,
  source: ChunkedSampleSource,
): Promise<Buffer> {
  const manifest = await verifiedManifest(ref, source);
  const ids: UploadIds = { datasetId: manifest.datasetId, uploadId: manifest.uploadId };
  const key = await crypto.subtle.importKey("raw", new Uint8Array(uploadKey), "AES-GCM", false, ["decrypt"]);
  const plain = new Map<number, Uint8Array<ArrayBuffer>>();
  const chunk = async (index: number) => {
    const cached = plain.get(index);
    if (cached) return cached;
    const object = await source.readChunk(index);
    const record = manifest.chunks[index];
    if (createHash("sha256").update(object).digest("hex") !== record.sha256) throw integrityError(ref.datasetId);
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = await decryptChunk(key, ids, index, manifest.chunkCount, record.plainBytes, object);
    } catch {
      throw integrityError(ref.datasetId);
    }
    plain.set(index, bytes);
    return bytes;
  };

  // Fichier dans les limites : pris en entier, sans perdre les lignes à cheval sur deux morceaux.
  if (manifest.plainBytes <= SAMPLE_MAX_BYTES) {
    const parts: Uint8Array[] = [];
    for (let index = 0; index < manifest.chunkCount; index++) parts.push(await chunk(index));
    const whole = Buffer.concat(parts);
    try {
      parseCsv(whole.toString("utf-8"));
      return whole;
    } catch {
      // Trop de lignes : échantillon ci-dessous.
    }
  }

  // Assez de morceaux pour remplir l'échantillon : 8 morceaux de 8 Mio, ou plus s'ils sont petits.
  const wanted = Math.min(MAX_SAMPLE_CHUNKS, Math.max(SAMPLE_CHUNKS, Math.ceil(SAMPLE_MAX_BYTES / manifest.chunkBytes)));
  const indexes = sampleChunkIndexes(manifest.chunkCount, wanted);
  const decoder = new TextDecoder("utf-8");
  const firstText = decoder.decode(await chunk(0));
  const headerEnd = firstText.indexOf("\n");
  const header = (headerEnd < 0 ? firstText : firstText.slice(0, headerEnd)).replace(/\r$/, "");
  const rowsPerChunk = Math.floor(SAMPLE_MAX_ROWS / indexes.length);
  const bytesPerChunk = Math.floor((SAMPLE_MAX_BYTES - header.length - HEADER_MARGIN_BYTES) / indexes.length);

  const lines = [header];
  for (const index of indexes) {
    const text = index === 0 ? firstText : decoder.decode(await chunk(index));
    const all = completeLines(text, index === 0, index === manifest.chunkCount - 1);
    // Le premier morceau commence par l'en-tête, déjà pris.
    const candidates = index === 0 ? all.slice(1) : all;
    let rows = 0;
    let bytes = 0;
    for (const line of candidates) {
      if (line === "") continue;
      if (rows >= rowsPerChunk || bytes + line.length + 1 > bytesPerChunk) break;
      lines.push(line);
      rows += 1;
      bytes += line.length + 1;
    }
  }
  const sample = Buffer.from(`${lines.join("\n")}\n`);
  try {
    parseCsv(sample.toString("utf-8"));
    return sample;
  } catch {
    return prefixSample(manifest, chunk);
  }
}

/** Source R2 du runner (jeton en lecture seule de sa configuration). */
export function r2SampleSource(ids: UploadIds, signal?: AbortSignal): ChunkedSampleSource {
  let config: ReturnType<typeof r2ConfigFromEnv>;
  try {
    config = r2ConfigFromEnv();
  } catch {
    throw new AppError("Envoi en morceaux indisponible sur ce runner", 503);
  }
  const read = async (key: string) => {
    try {
      return await r2GetObject(config, key, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RunnerRetryLater("Stockage momentanément injoignable : réessaie dans quelques minutes");
    }
  };
  return {
    readManifest: () => read(manifestObjectKey(ids)),
    readChunk: (index) => read(chunkObjectKey(ids, index)),
  };
}
