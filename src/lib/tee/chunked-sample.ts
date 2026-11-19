import { createHash } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { MAX_CSV_ROWS, parseCsv } from "@/lib/sirius/metrics";
import { r2ConfigFromEnv, r2GetObject } from "@/lib/storage/r2";
import { RunnerRetryLater } from "@/lib/runner/failure-policy";
import { MAX_CELL_CHARS, StrictCsvStream } from "@/lib/upload/csv-stream";
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
 *
 * Mémoire (audit du 11 novembre, U1) : seules les lignes retenues sont décodées, jamais un morceau
 * entier découpé en lignes, et aucun morceau n'est gardé en cache : un morceau de 64 Mio à lignes
 * courtes faisait sortir le runner de son tas.
 *
 * Champs multilignes (audit du 11 novembre, U5) : au milieu d'un morceau, on ne sait pas si l'on est
 * dans un champ entre guillemets. Le scellement a validé tout le fichier avec le lecteur strict, qui
 * borne chaque cellule à `MAX_CELL_CHARS` caractères, donc à `QUOTE_GUARD_BYTES` octets au plus : un
 * champ entre guillemets qui toucherait les lignes retenues aurait un guillemet à moins de cette
 * distance. Sans aucun guillemet dans cette marge, de part et d'autre, les lignes retenues sont de
 * vraies lignes du fichier ; sinon, l'échantillon est pris au début du fichier par le lecteur strict.
 */

export const SAMPLE_CHUNKS = 8;
const MAX_SAMPLE_CHUNKS = 64;
export const SAMPLE_MAX_BYTES = MAX_DATASET_BYTES;
/** `parseCsv` compte l'en-tête dans sa limite de lignes. */
export const SAMPLE_MAX_ROWS = MAX_CSV_ROWS - 1;
const HEADER_MARGIN_BYTES = 1024;
/** Octets UTF-8 d'une cellule au plus (3 par unité UTF-16) et ses deux guillemets, arrondis à 32 Kio. */
export const QUOTE_GUARD_BYTES = Math.max(32 * 1024, MAX_CELL_CHARS * 3 + 2);
const NEWLINE = 0x0a;
const QUOTE = 0x22;

function tail(bytes: Uint8Array, length: number): Uint8Array {
  return bytes.subarray(Math.max(0, bytes.length - length));
}

/** Octets UTF-8 d'une ligne de l'échantillon, retour à la ligne compris : la limite se compte en octets, pas en caractères. */
function lineBytes(line: string): number {
  return Buffer.byteLength(line, "utf8") + 1;
}

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
      bytes += lineBytes(head);
    }
    const line = row.map(quoteField).join(",");
    if (lines.length - 1 >= SAMPLE_MAX_ROWS || bytes + lineBytes(line) > SAMPLE_MAX_BYTES) {
      full = true;
      return;
    }
    lines.push(line);
    bytes += lineBytes(line);
  });
  for (let index = 0; index < manifest.chunkCount && !full; index++) csv.pushBytes(await chunk(index));
  if (!full) csv.end();
  return Buffer.from(`${lines.join("\n")}\n`);
}

/**
 * Lignes retenues d'une fenêtre d'octets, sans décoder ni découper le reste : au plus `maxRows`
 * lignes et `maxBytes` octets, à partir de la première ligne entière commençant après `from`
 * (exactement à `from` en début de fichier, juste après l'en-tête). Les lignes retenues finissent
 * avant `until`. Rend `null` si elles ne sont pas sûres (U5) : guillemet à moins de
 * `QUOTE_GUARD_BYTES` octets de part et d'autre, ou marge absente de la fenêtre alors que ce
 * n'est pas une limite du fichier.
 */
export function chunkSampleLines(
  bytes: Uint8Array,
  options: { fileStart: boolean; fileEnd: boolean; from: number; until: number; maxRows: number; maxBytes: number },
): string[] | null {
  const { fileStart, fileEnd, until, maxRows, maxBytes } = options;
  let start = options.from;
  if (!fileStart) {
    // Première ligne entière, avec une marge complète avant elle.
    const newline = bytes.indexOf(NEWLINE, Math.max(options.from, QUOTE_GUARD_BYTES));
    if (newline < 0 || newline + 1 >= until) return null;
    start = newline + 1;
  }
  let end = start;
  let rows = 0;
  while (rows < maxRows && end < until) {
    const newline = bytes.indexOf(NEWLINE, end);
    // Dernière ligne sans retour final : seulement à la fin réelle du fichier.
    const lineEnd = newline < 0 || newline >= until ? (fileEnd && newline < 0 ? until : -1) : newline + 1;
    if (lineEnd < 0 || lineEnd - start > maxBytes) break;
    end = lineEnd;
    rows += 1;
  }
  if (!fileEnd && end + QUOTE_GUARD_BYTES > bytes.length) return null;
  const guardStart = fileStart ? 0 : start - QUOTE_GUARD_BYTES;
  if (bytes.subarray(guardStart, Math.min(bytes.length, end + QUOTE_GUARD_BYTES)).includes(QUOTE)) return null;
  if (end === start) return [];
  const text = new TextDecoder("utf-8").decode(bytes.subarray(start, end));
  return text
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line !== "");
}

export async function chunkedTrainingSample(
  ref: ChunkedSampleRef,
  uploadKey: Buffer,
  source: ChunkedSampleSource,
): Promise<Buffer> {
  const manifest = await verifiedManifest(ref, source);
  const ids: UploadIds = { datasetId: manifest.datasetId, uploadId: manifest.uploadId };
  const key = await crypto.subtle.importKey("raw", new Uint8Array(uploadKey), "AES-GCM", false, ["decrypt"]);
  // Pas de cache : chaque morceau est relu et lâché après usage (U1).
  const chunk = async (index: number) => {
    const object = await source.readChunk(index);
    const record = manifest.chunks[index];
    if (createHash("sha256").update(object).digest("hex") !== record.sha256) throw integrityError(ref.datasetId);
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = await decryptChunk(key, ids, index, manifest.chunkCount, record.plainBytes, object);
    } catch {
      throw integrityError(ref.datasetId);
    }
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
  const first = await chunk(0);
  const headerEnd = first.indexOf(NEWLINE);
  if (headerEnd < 0) return prefixSample(manifest, chunk);
  const header = new TextDecoder("utf-8").decode(first.subarray(0, headerEnd)).replace(/\r$/, "");
  const rowsPerChunk = Math.floor(SAMPLE_MAX_ROWS / indexes.length);
  const bytesPerChunk = Math.floor((SAMPLE_MAX_BYTES - lineBytes(header) - HEADER_MARGIN_BYTES) / indexes.length);

  const lines = [header];
  const lastIndex = manifest.chunkCount - 1;
  for (const index of indexes) {
    const current = index === 0 ? first : await chunk(index);
    // Petits morceaux : la marge se lit dans les voisins (QUOTE_GUARD_BYTES seulement). Les morceaux
    // de 8 Mio du site la contiennent déjà : aucune lecture de plus.
    const small = current.length < 4 * QUOTE_GUARD_BYTES;
    const before = index > 0 && small ? tail(await chunk(index - 1), QUOTE_GUARD_BYTES) : new Uint8Array(0);
    const after = index < lastIndex && small ? (await chunk(index + 1)).subarray(0, QUOTE_GUARD_BYTES) : new Uint8Array(0);
    const window = before.length === 0 && after.length === 0 ? current : Buffer.concat([before, current, after]);
    const taken = chunkSampleLines(window, {
      fileStart: index === 0,
      fileEnd: index === lastIndex,
      // Le premier morceau commence par l'en-tête, déjà pris.
      from: index === 0 ? headerEnd + 1 : before.length,
      until: before.length + current.length,
      maxRows: rowsPerChunk,
      maxBytes: bytesPerChunk,
    });
    // Lignes pas sûres (champ entre guillemets possible) : échantillon par le lecteur strict.
    if (taken === null) return prefixSample(manifest, chunk);
    lines.push(...taken);
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
