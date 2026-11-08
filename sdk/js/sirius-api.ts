/**
 * SDK JavaScript de l'API développeurs Sirius (D-30). Un seul fichier, sans dépendance :
 * `fetch` et WebCrypto (navigateur, Node ≥ 20, Deno, Bun).
 *
 * Chaque requête est signée en HMAC-SHA256 avec le secret de la clé (`sk_live_<keyId>.<secret>`).
 * Le secret ne voyage jamais : seule la signature part, avec l'identifiant de clé, l'horodatage et
 * un nonce à usage unique. L'enclave ne tourne que pendant l'usage : le premier appel après une
 * pause (environ une heure sans activité) peut prendre environ 2 minutes, l'API répondant
 * `503 enclave_starting` avec `Retry-After` ; le client attend et réessaie seul (nouvelle
 * signature) jusqu'à `maxRetryWaitMs` (8 min par défaut).
 *
 * Usage :
 *   const sirius = new SiriusClient({ apiKey: process.env.SIRIUS_API_KEY! });
 *   const info = await sirius.info("<loanId>");
 *   const result = await sirius.predict("<loanId>", { age: 42, income: 51000 });
 */

export const SIRIUS_API_BASE_URL = "https://api.sirius-data.tech";
/** Doit rester identique à `API_SIGNING_PREFIX` (src/lib/billing/api-pricing.ts). */
export const SIRIUS_SIGNING_PREFIX = "SIRIUS-HMAC-SHA256";
/** Démarrage à froid mesuré : environ 2 min, jusqu'à 5 min ; marge pour les relances espacées par `Retry-After`. */
const DEFAULT_MAX_RETRY_WAIT_MS = 8 * 60_000;
const DEFAULT_RETRY_AFTER_SECONDS = 15;

/** Codes d'erreur stables renvoyés par l'API (`{ error: { code, message } }`). */
export type SiriusErrorCode =
  | "invalid_signature"
  | "request_expired"
  | "replayed_request"
  | "key_revoked"
  | "unknown_key"
  | "rental_expired"
  | "api_access_required"
  | "quota_exceeded"
  | "api_not_available_for_profile"
  | "invalid_features"
  | "enclave_starting"
  | "rate_limited"
  | "payload_too_large"
  | "not_found"
  | "model_unavailable"
  | "invalid_request"
  | "runner_unavailable"
  | "runner_error"
  | (string & {});

export class SiriusApiError extends Error {
  constructor(
    message: string,
    readonly code: SiriusErrorCode,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "SiriusApiError";
  }
}

export interface Remaining {
  /** Appels restants dans le quota du jour (UTC), site et API confondus. */
  today: number;
  /** Appels prépayés restants (packs), consommés après le quota du jour. */
  credits: number;
}

export interface PredictResponse {
  outputKind: "decision" | "value";
  /** Présent si `outputKind === "decision"` : 0 ou 1. */
  decision?: number | string;
  /** Présent si `outputKind === "value"` : valeur arrondie, en texte. */
  value?: string;
  counter: number;
  remaining: Remaining;
  /** Fin de la location (ISO 8601). */
  expiresAt: string;
  modelId: string;
  modelVersion: string;
  /** Signature EIP-712 `SiriusPrediction` de l'enclave, vérifiable hors ligne. */
  signature: string;
  signer: string;
  domain: Record<string, unknown>;
  signedMessage: Record<string, unknown>;
}

export interface ModelInfo {
  loanId: string;
  modelId: string;
  modelVersion: string;
  features: string[];
  expiresAt: string;
  remaining: Remaining;
}

export interface CanonicalInput {
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  bodySha256Hex: string;
}

/**
 * Chaîne signée : préfixe, méthode en majuscules, chemin public sans query
 * (`/v1/models/<loanId>/predict`), horodatage en secondes, nonce, sha256 hex du corps brut.
 */
export function canonicalString(input: CanonicalInput): string {
  if (!Number.isSafeInteger(input.timestamp)) throw new Error("timestamp must be an integer number of seconds");
  const query = input.path.indexOf("?");
  const path = query === -1 ? input.path : input.path.slice(0, query);
  return [SIRIUS_SIGNING_PREFIX, input.method.toUpperCase(), path, String(input.timestamp), input.nonce, input.bodySha256Hex.toLowerCase()].join("\n");
}

const encoder = new TextEncoder();

function subtle(): SubtleCrypto {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error("WebCrypto is unavailable: use Node ≥ 20 or a modern browser");
  return value;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Découpe `sk_live_<keyId>.<secret>` ; le secret est la forme base64url de 32 octets. */
export function parseApiKey(apiKey: string): { keyId: string; secret: string } {
  const match = /^sk_live_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(apiKey.trim());
  if (!match) throw new Error("Invalid Sirius API key: expected sk_live_<keyId>.<secret>");
  return { keyId: match[1], secret: match[2] };
}

export async function sha256Hex(body: string): Promise<string> {
  return hex(await subtle().digest("SHA-256", encoder.encode(body)));
}

/** Signature HMAC-SHA256 (hex minuscule) de la chaîne canonique, clé = 32 octets décodés du secret. */
export async function signRequest(input: {
  secret: string;
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body: string;
}): Promise<{ signature: string; canonical: string; bodySha256Hex: string }> {
  const bodySha256Hex = await sha256Hex(input.body);
  const canonical = canonicalString({ method: input.method, path: input.path, timestamp: input.timestamp, nonce: input.nonce, bodySha256Hex });
  const key = await subtle().importKey("raw", base64UrlDecode(input.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = hex(await subtle().sign("HMAC", key, encoder.encode(canonical)));
  return { signature, canonical, bodySha256Hex };
}

export function randomNonce(): string {
  return base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(18)));
}

export interface SiriusClientOptions {
  /** `sk_live_<keyId>.<secret>`, affichée une seule fois à la création. */
  apiKey: string;
  /** Défaut `https://api.sirius-data.tech`. Hors de cet hôte : `https://<site>/api`. */
  baseUrl?: string;
  /** Attente cumulée maximale sur `503 enclave_starting` (défaut 8 min ; 0 = jamais réessayer). */
  maxRetryWaitMs?: number;
  fetch?: typeof fetch;
  /** Horloge et attente injectables (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  nonce?: () => string;
}

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function retryAfterSeconds(header: string | null, body: unknown): number {
  const fromBody = (body as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  for (const value of [header === null ? undefined : Number(header), fromBody]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.ceil(value);
  }
  return DEFAULT_RETRY_AFTER_SECONDS;
}

export class SiriusClient {
  readonly keyId: string;
  readonly #secret: string;
  readonly #baseUrl: string;
  readonly #maxRetryWaitMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #nonce: () => string;

  constructor(options: SiriusClientOptions) {
    const { keyId, secret } = parseApiKey(options.apiKey);
    this.keyId = keyId;
    this.#secret = secret;
    this.#baseUrl = (options.baseUrl ?? SIRIUS_API_BASE_URL).replace(/\/+$/, "");
    this.#maxRetryWaitMs = options.maxRetryWaitMs ?? DEFAULT_MAX_RETRY_WAIT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#nonce = options.nonce ?? randomNonce;
  }

  /** Prédiction signée par l'enclave ; consomme un appel (quota du jour, puis crédits). */
  predict(loanId: string, features: Record<string, number>): Promise<PredictResponse> {
    for (const [name, value] of Object.entries(features)) {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Feature ${name} must be a finite number`);
    }
    return this.#request<PredictResponse>("POST", `/v1/models/${encodeURIComponent(loanId)}/predict`, JSON.stringify({ features }));
  }

  /** Profil du modèle, variables attendues et appels restants ; ne consomme pas de quota. */
  info(loanId: string): Promise<ModelInfo> {
    return this.#request<ModelInfo>("GET", `/v1/models/${encodeURIComponent(loanId)}`, "");
  }

  async #request<T>(method: "GET" | "POST", path: string, body: string): Promise<T> {
    let waited = 0;
    for (;;) {
      // Nouvel horodatage et nouveau nonce à chaque essai : l'API refuse le rejeu.
      const timestamp = Math.floor(this.#now() / 1000);
      const nonce = this.#nonce();
      const { signature } = await signRequest({ secret: this.#secret, method, path, timestamp, nonce, body });
      const headers: Record<string, string> = {
        "Sirius-Key": this.keyId,
        "Sirius-Timestamp": String(timestamp),
        "Sirius-Nonce": nonce,
        "Sirius-Signature": signature,
      };
      if (method === "POST") headers["Content-Type"] = "application/json";
      const response = await this.#fetch(`${this.#baseUrl}${path}`, { method, headers, body: method === "POST" ? body : undefined });
      const parsed = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      if (response.ok) return parsed as T;
      const code = parsed?.error?.code ?? `http_${response.status}`;
      const message = parsed?.error?.message ?? `Sirius API error ${response.status}`;
      if (response.status === 503) {
        const seconds = retryAfterSeconds(response.headers.get("Retry-After"), parsed);
        if (waited + seconds * 1000 <= this.#maxRetryWaitMs) {
          waited += seconds * 1000;
          await this.#sleep(seconds * 1000);
          continue;
        }
        throw new SiriusApiError(message, code, response.status, seconds);
      }
      throw new SiriusApiError(message, code, response.status);
    }
  }
}
