import { createHash, createHmac } from "node:crypto";
import { chunkObjectKey, type UploadIds } from "@/lib/upload/chunked";

/**
 * Accès à Cloudflare R2 par son API compatible S3, signé en AWS Signature V4 sans SDK.
 *
 * - Le site signe des URL d'envoi courtes (un morceau chacune) : le navigateur envoie le chiffré
 *   directement à R2, sans passer par Vercel.
 * - Le runner relit les morceaux avec un jeton en lecture seule.
 *
 * Les identifiants viennent de l'environnement du processus : jeton lecture-écriture pour le site,
 * lecture seule pour le runner. Ils ne sont jamais renvoyés ni journalisés.
 */

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const MAX_PRESIGN_SECONDS = 3600;
const READ_ATTEMPTS = 3;

export function r2ConfigFromEnv(env: Record<string, string | undefined> = process.env): R2Config {
  const config = {
    accountId: env.R2_ACCOUNT_ID?.trim() ?? "",
    accessKeyId: env.R2_ACCESS_KEY_ID?.trim() ?? "",
    secretAccessKey: env.R2_SECRET_ACCESS_KEY?.trim() ?? "",
    bucket: env.R2_BUCKET?.trim() ?? "",
  };
  if (!ACCOUNT_ID_RE.test(config.accountId) || !config.accessKeyId || !config.secretAccessKey || !BUCKET_RE.test(config.bucket)) {
    throw new Error("Stockage R2 non configuré");
  }
  return config;
}

// ---------------------------------------------------------------------------------------------------------------
// Signature V4

export interface SigningRequest {
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  host: string;
  /** Chemin déjà découpé en segments bruts : chacun est encodé ici. */
  path: string;
  query?: Record<string, string>;
  /** En-têtes signés, en plus de `host` (noms en minuscules). */
  headers?: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}

/** Encodage URI de SigV4 : RFC 3986, seuls `A-Z a-z 0-9 - _ . ~` restent tels quels. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePath(path: string): string {
  return path.split("/").map(encodeRfc3986).join("/");
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(query[key])}`)
    .join("&");
}

function amzDates(now: Date): { amzDate: string; day: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, day: amzDate.slice(0, 8) };
}

function signingKey(secretAccessKey: string, day: string, region: string): Buffer {
  let key = createHmac("sha256", `AWS4${secretAccessKey}`).update(day).digest();
  for (const part of [region, "s3", "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
  return key;
}

function signature(request: SigningRequest, query: Record<string, string>, headers: Record<string, string>): string {
  const { day, amzDate } = amzDates(request.now);
  const names = Object.keys(headers).sort();
  const canonical = [
    request.method,
    encodePath(request.path),
    canonicalQuery(query),
    names.map((name) => `${name}:${headers[name].trim()}\n`).join(""),
    names.join(";"),
    request.payloadHash,
  ].join("\n");
  const scope = `${day}/${request.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  return createHmac("sha256", signingKey(request.secretAccessKey, day, request.region)).update(toSign).digest("hex");
}

/** En-têtes d'une requête signée (dont `authorization`), `host` exclu : `fetch` le pose. */
export function signedHeaders(request: SigningRequest): Record<string, string> {
  const { day, amzDate } = amzDates(request.now);
  const headers: Record<string, string> = {
    host: request.host,
    ...request.headers,
    "x-amz-content-sha256": request.payloadHash,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(headers).sort();
  const scope = `${day}/${request.region}/s3/aws4_request`;
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, ` +
    `Signature=${signature(request, request.query ?? {}, headers)}`;
  delete headers.host;
  return { ...headers, authorization };
}

/** URL pré-signée : la signature est dans la requête, le corps n'est pas signé. */
export function presignedQuery(request: Omit<SigningRequest, "payloadHash" | "headers">, expiresSeconds: number): string {
  const { day, amzDate } = amzDates(request.now);
  const query: Record<string, string> = {
    ...request.query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${request.accessKeyId}/${day}/${request.region}/s3/aws4_request`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const sig = signature({ ...request, payloadHash: UNSIGNED_PAYLOAD }, query, { host: request.host });
  return `${canonicalQuery(query)}&X-Amz-Signature=${sig}`;
}

// ---------------------------------------------------------------------------------------------------------------
// R2

function r2Host(config: R2Config): string {
  return `${config.accountId}.r2.cloudflarestorage.com`;
}

/**
 * URL d'envoi d'un objet, valable `expiresSeconds` : le navigateur y fait un `PUT` du corps brut.
 * Avec `uploadId` et `partNumber`, c'est une partie d'un envoi multipart R2.
 */
export function presignR2Put(
  config: R2Config,
  key: string,
  expiresSeconds: number,
  multipart?: { uploadId: string; partNumber: number },
  now = new Date(),
): string {
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > MAX_PRESIGN_SECONDS) {
    throw new Error("Durée de validité invalide");
  }
  const host = r2Host(config);
  const path = `/${config.bucket}/${key}`;
  const query = multipart ? { partNumber: String(multipart.partNumber), uploadId: multipart.uploadId } : undefined;
  const signed = presignedQuery(
    { method: "PUT", host, path, query, region: "auto", accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, now },
    expiresSeconds,
  );
  return `https://${host}${encodePath(path)}?${signed}`;
}

async function r2Request(
  config: R2Config,
  method: SigningRequest["method"],
  key: string,
  init: { body?: Uint8Array<ArrayBuffer>; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const host = r2Host(config);
  const path = `/${config.bucket}/${key}`;
  const body = init.body;
  const headers = signedHeaders({
    method,
    host,
    path,
    payloadHash: body ? createHash("sha256").update(body).digest("hex") : EMPTY_SHA256,
    region: "auto",
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    now: new Date(),
  });
  return (init.fetchImpl ?? fetch)(`https://${host}${encodePath(path)}`, { method, headers, body, signal: init.signal });
}

/**
 * Lit un objet entier. Les erreurs passagères (réseau, 5xx, 429) sont réessayées ; un objet
 * absent ou un accès refusé ne l'est pas. Le message ne contient ni clé ni signature.
 */
export async function r2GetObject(
  config: R2Config,
  key: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; retryDelayMs?: number } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    let response: Response | null = null;
    try {
      response = await r2Request(config, "GET", key, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
    }
    if (response?.ok) return new Uint8Array(await response.arrayBuffer());
    if (response) {
      lastStatus = response.status;
      await response.body?.cancel();
      if (response.status < 500 && response.status !== 429) break;
    }
    if (attempt < READ_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, (options.retryDelayMs ?? 500) * attempt));
  }
  throw new Error(lastStatus ? `Lecture du stockage refusée (HTTP ${lastStatus})` : "Stockage injoignable");
}

/** Source des morceaux d'un envoi, pour `sealChunkedDataset` et l'entraînement. */
export function r2ChunkSource(config: R2Config, ids: UploadIds, signal?: AbortSignal) {
  return {
    readChunk: (index: number) => r2GetObject(config, chunkObjectKey(ids, index), { signal }),
  };
}

/** Écrit un objet depuis le serveur (le manifeste, après vérification). */
export async function r2PutObject(config: R2Config, key: string, body: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<void> {
  const response = await r2Request(config, "PUT", key, { body, signal });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Écriture du stockage refusée (HTTP ${response.status})`);
}

/** Supprime un objet (envoi abandonné, nettoyage). Un objet déjà absent n'est pas une erreur. */
export async function r2DeleteObject(config: R2Config, key: string, signal?: AbortSignal): Promise<void> {
  const response = await r2Request(config, "DELETE", key, { signal });
  await response.body?.cancel();
  if (!response.ok && response.status !== 404) throw new Error(`Suppression refusée (HTTP ${response.status})`);
}
