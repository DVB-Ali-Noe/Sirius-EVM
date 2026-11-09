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

/**
 * URL pré-signée : la signature est dans la requête, le corps n'est pas signé. Les en-têtes de
 * `headers` (noms en minuscules) sont signés : le client doit envoyer exactement ces valeurs.
 */
export function presignedQuery(request: Omit<SigningRequest, "payloadHash">, expiresSeconds: number): string {
  const { day, amzDate } = amzDates(request.now);
  const headers: Record<string, string> = { host: request.host, ...request.headers };
  const query: Record<string, string> = {
    ...request.query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${request.accessKeyId}/${day}/${request.region}/s3/aws4_request`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSeconds),
    "X-Amz-SignedHeaders": Object.keys(headers).sort().join(";"),
  };
  const sig = signature({ ...request, payloadHash: UNSIGNED_PAYLOAD }, query, headers);
  return `${canonicalQuery(query)}&X-Amz-Signature=${sig}`;
}

// ---------------------------------------------------------------------------------------------------------------
// R2

function r2Host(config: R2Config): string {
  return `${config.accountId}.r2.cloudflarestorage.com`;
}

/**
 * URL d'envoi d'un objet, valable `expiresSeconds` : le navigateur y fait un `PUT` du corps brut.
 * Avec `uploadId` et `partNumber`, c'est une partie d'un envoi multipart R2. Avec `contentLength`,
 * la taille est signée : R2 refuse un corps d'une autre taille.
 */
export function presignR2Put(
  config: R2Config,
  key: string,
  expiresSeconds: number,
  multipart?: { uploadId: string; partNumber: number },
  now = new Date(),
  contentLength?: number,
): string {
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > MAX_PRESIGN_SECONDS) {
    throw new Error("Durée de validité invalide");
  }
  const host = r2Host(config);
  const path = `/${config.bucket}/${key}`;
  const query = multipart ? { partNumber: String(multipart.partNumber), uploadId: multipart.uploadId } : undefined;
  if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 1)) {
    throw new Error("Taille d'envoi invalide");
  }
  const headers = contentLength === undefined ? undefined : { "content-length": String(contentLength) };
  const signed = presignedQuery(
    { method: "PUT", host, path, query, headers, region: "auto", accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, now },
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

export interface R2ObjectSummary {
  key: string;
  size: number;
}

const MAX_LIST_PAGES = 50;

function xmlValues(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map((match) => match[1]);
}

/**
 * Liste les objets sous un préfixe (ListObjectsV2, pages de 1 000). Les clés de Sirius n'ont que
 * des caractères sûrs : aucune entité XML à décoder. Au plus 50 000 objets.
 */
export async function r2ListObjects(
  config: R2Config,
  prefix: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<R2ObjectSummary[]> {
  const host = r2Host(config);
  const path = `/${config.bucket}`;
  const objects: R2ObjectSummary[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const query: Record<string, string> = { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) };
    const headers = signedHeaders({
      method: "GET",
      host,
      path,
      query,
      payloadHash: EMPTY_SHA256,
      region: "auto",
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      now: new Date(),
    });
    const response = await (options.fetchImpl ?? fetch)(`https://${host}${encodePath(path)}?${canonicalQuery(query)}`, {
      headers,
      signal: options.signal,
    });
    const xml = await response.text();
    if (!response.ok) throw new Error(`Liste du stockage refusée (HTTP ${response.status})`);
    for (const block of xmlValuesBlocks(xml)) {
      const [key] = xmlValues(block, "Key");
      const [size] = xmlValues(block, "Size");
      if (key !== undefined && size !== undefined && /^\d+$/.test(size)) objects.push({ key, size: Number(size) });
    }
    if (xmlValues(xml, "IsTruncated")[0] !== "true") return objects;
    token = xmlValues(xml, "NextContinuationToken")[0];
    if (!token) return objects;
  }
  throw new Error("Trop d'objets sous ce préfixe");
}

function xmlValuesBlocks(xml: string): string[] {
  return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((match) => match[1]);
}

/** Supprime tous les objets d'un préfixe (envoi abandonné ou refusé). Renvoie leur nombre. */
export async function r2DeletePrefix(config: R2Config, prefix: string, signal?: AbortSignal): Promise<number> {
  if (!prefix.endsWith("/") || prefix.length < 3) throw new Error("Préfixe de suppression invalide");
  const objects = await r2ListObjects(config, prefix, { signal });
  for (const { key } of objects) await r2DeleteObject(config, key, signal);
  return objects.length;
}
