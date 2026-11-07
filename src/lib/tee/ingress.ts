import "server-only";
import { createDecipheriv, createECDH, createHash, hkdfSync } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { deriveKey, getMasterKey } from "@/lib/crypto/encryption";
import {
  API_KEY_ID_PATTERN,
  API_KEY_INGRESS_INFO_PREFIX,
  API_KEY_SECRET_BYTES,
  DATASET_INGRESS_INFO_PREFIX,
  MAX_DATASET_BYTES,
  type ApiKeySecretEnvelope,
  type DatasetIngressEnvelope,
  type DatasetIngressKey,
} from "./contract";
import { UPLOAD_KEY_INFO_PREFIX } from "@/lib/upload/chunked";

const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const ONE = BigInt(1);
const AUTH_TAG_BYTES = 16;
const MAX_CIPHERTEXT_BYTES = MAX_DATASET_BYTES + AUTH_TAG_BYTES;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function ingressEcdh() {
  const seed = deriveKey(getMasterKey(), "dataset-ingress:ecdh-p256:v1");
  const scalar = (BigInt(`0x${seed.toString("hex")}`) % (P256_ORDER - ONE)) + ONE;
  const privateKey = Buffer.from(scalar.toString(16).padStart(64, "0"), "hex");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privateKey);
  return ecdh;
}

function decodeField(value: unknown, name: string, maxBytes: number, exactBytes?: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil((maxBytes * 4) / 3) + 4 ||
    !BASE64URL_RE.test(value)
  ) {
    throw new AppError(`${name} invalide`, 400);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length > maxBytes || (exactBytes !== undefined && decoded.length !== exactBytes)) {
    throw new AppError(`${name} invalide`, 400);
  }
  return decoded;
}

export function datasetIngressPublicKey(): DatasetIngressKey {
  const origin = process.env.SIRIUS_APP_ORIGIN?.trim();
  if (process.env.NODE_ENV === "production" && !origin) {
    throw new Error("SIRIUS_APP_ORIGIN obligatoire en production");
  }
  return {
    version: 1,
    publicKey: cachedIngressPublicKey(),
    origin: origin ?? "http://localhost:3000",
  };
}

/**
 * La clé publique d'ingestion ne dépend que de la master key : elle est dérivée une fois (HKDF,
 * réduction modulo, multiplication scalaire P-256) puis resservie, au lieu d'être recalculée à
 * chaque appel gratuit `dataset-ingress-key` (audit ROB-08). Le cache est indexé par l'empreinte de
 * la master key, jamais par la clé elle-même : une autre master key (tests, simulateur) le renouvelle.
 */
let ingressPublicKeyCache: { masterKeySha256: string; publicKey: string } | null = null;

function cachedIngressPublicKey(): string {
  const masterKeySha256 = createHash("sha256").update(getMasterKey()).digest("hex");
  if (ingressPublicKeyCache?.masterKeySha256 !== masterKeySha256) {
    ingressPublicKeyCache = {
      masterKeySha256,
      publicKey: ingressEcdh().getPublicKey(undefined, "uncompressed").toString("base64url"),
    };
  }
  return ingressPublicKeyCache.publicKey;
}

export function datasetIngressKeyFingerprint(): string {
  const publicKey = Buffer.from(datasetIngressPublicKey().publicKey, "base64url");
  return createHash("sha256").update(publicKey).digest("hex");
}

export function decryptDatasetIngress(datasetId: string, envelope: DatasetIngressEnvelope): Buffer {
  if (!envelope || envelope.version !== 1) throw new AppError("Enveloppe dataset incompatible", 400);

  const ephemeralPublicKey = decodeField(envelope.ephemeralPublicKey, "Clé éphémère", 65, 65);
  const salt = decodeField(envelope.salt, "Sel", 16, 16);
  const iv = decodeField(envelope.iv, "IV", 12, 12);
  const sealed = decodeField(envelope.ciphertext, "Dataset chiffré", MAX_CIPHERTEXT_BYTES);
  if (sealed.length <= AUTH_TAG_BYTES) throw new AppError("Dataset chiffré vide", 400);

  try {
    return openIngressCiphertext(ephemeralPublicKey, salt, iv, sealed, `${DATASET_INGRESS_INFO_PREFIX}${datasetId}`, datasetId);
  } catch {
    throw new AppError("Enveloppe dataset invalide", 400);
  }
}

/** ECDH avec la clé d'ingestion, HKDF-SHA256 (`info`), puis AES-256-GCM authentifié sur `aad`. Lève si invalide. */
function openIngressCiphertext(ephemeralPublicKey: Buffer, salt: Buffer, iv: Buffer, sealed: Buffer, info: string, aad: string): Buffer {
  const sharedSecret = ingressEcdh().computeSecret(ephemeralPublicKey);
  const key = Buffer.from(hkdfSync("sha256", sharedSecret, salt, Buffer.from(info), 32));
  const ciphertext = sealed.subarray(0, -AUTH_TAG_BYTES);
  const tag = sealed.subarray(-AUTH_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_BYTES });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Champs exacts d'une enveloppe de secret de clé API : rien d'autre n'est accepté (empreinte signée dans le grant). */
const API_KEY_ENVELOPE_FIELDS = ["version", "ephemeralPublicKey", "salt", "iv", "ciphertext"] as const;

/**
 * Empreinte SHA-256 hexadécimale du JSON canonique de l'enveloppe (clés dans l'ordre
 * `version, ephemeralPublicKey, salt, iv, ciphertext`), signée par le wallet dans le grant
 * `register-api-key` : même calcul que `apiKeyEnvelopeSha256` côté navigateur.
 */
export function apiKeyEnvelopeDigest(envelope: ApiKeySecretEnvelope): string {
  const canonical = Object.fromEntries(API_KEY_ENVELOPE_FIELDS.map((field) => [field, envelope[field]]));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Enveloppe reçue du navigateur : objet aux cinq champs exacts, version 1. */
export function parseApiKeyEnvelope(value: unknown): ApiKeySecretEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("Enveloppe de clé API manquante", 400);
  const keys = Object.keys(value);
  if (keys.length !== API_KEY_ENVELOPE_FIELDS.length || API_KEY_ENVELOPE_FIELDS.some((field) => !keys.includes(field))
    || (value as ApiKeySecretEnvelope).version !== 1
    || API_KEY_ENVELOPE_FIELDS.slice(1).some((field) => typeof (value as Record<string, unknown>)[field] !== "string")) {
    throw new AppError("Enveloppe de clé API incompatible", 400);
  }
  return value as ApiKeySecretEnvelope;
}

/**
 * Secret d'une clé API (32 octets bruts), chiffré par le navigateur pour l'enclave avec la clé
 * d'ingestion : HKDF info `sirius-api-key-v1:<keyId>`, AAD = `keyId`. Il ne quitte le runner que
 * scellé sous la master key (api-keys.ts).
 */
export function decryptApiKeySecret(keyId: string, envelope: ApiKeySecretEnvelope): Buffer {
  if (!API_KEY_ID_PATTERN.test(keyId)) throw new AppError("Identifiant de clé API invalide", 400);
  const parsed = parseApiKeyEnvelope(envelope);
  const ephemeralPublicKey = decodeField(parsed.ephemeralPublicKey, "Clé éphémère", 65, 65);
  const salt = decodeField(parsed.salt, "Sel", 16, 16);
  const iv = decodeField(parsed.iv, "IV", 12, 12);
  const sealed = decodeField(parsed.ciphertext, "Secret chiffré", API_KEY_SECRET_BYTES + AUTH_TAG_BYTES, API_KEY_SECRET_BYTES + AUTH_TAG_BYTES);
  try {
    return openIngressCiphertext(ephemeralPublicKey, salt, iv, sealed, `${API_KEY_INGRESS_INFO_PREFIX}${keyId}`, keyId);
  } catch {
    throw new AppError("Enveloppe de clé API invalide", 400);
  }
}

/**
 * Clé d'un envoi en morceaux (`@/lib/upload/chunked`), recalculée dans l'enclave : même ECDH avec
 * la clé d'ingestion que l'enveloppe v1, puis le HKDF de `uploadKeyFromSharedSecret`. Renvoyée
 * brute pour être enveloppée par la master key au scellement ; elle ne quitte jamais le runner.
 */
export function deriveUploadKey(
  ids: { datasetId: string; uploadId: string },
  key: { ephemeralPublicKey: string; salt: string },
): Buffer {
  const ephemeralPublicKey = decodeField(key.ephemeralPublicKey, "Clé éphémère", 65, 65);
  const salt = decodeField(key.salt, "Sel", 16, 16);
  let sharedSecret: Buffer;
  try {
    sharedSecret = ingressEcdh().computeSecret(ephemeralPublicKey);
  } catch {
    throw new AppError("Clé d'envoi invalide", 400);
  }
  return Buffer.from(
    hkdfSync("sha256", sharedSecret, salt, Buffer.from(`${UPLOAD_KEY_INFO_PREFIX}${ids.datasetId}:${ids.uploadId}`), 32),
  );
}
