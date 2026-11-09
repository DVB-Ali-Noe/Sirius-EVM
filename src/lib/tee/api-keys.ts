import "server-only";
import { timingSafeEqual } from "node:crypto";
import { decrypt, deriveKey, encrypt, getMasterKey, type EncryptedPayload } from "@/lib/crypto/encryption";
import { AppError } from "@/lib/app-error";
import { API_KEY_MAX_PER_LOAN } from "@/lib/billing/api-pricing";
import { canonicalSubject } from "@/lib/subject";
import { API_KEY_ID_PATTERN, API_KEY_SECRET_BYTES, MODEL_REF_ID_PATTERN } from "./contract";
import { loanApiKeysPath, readPrivateFile, writePrivateFile } from "./served-models";

const MAX_KEYS_BYTES = 64 * 1024;
/** Clés révoquées comprises : borne la taille du fichier scellé d'un prêt. */
const MAX_RECORDS_PER_LOAN = 64;

/**
 * Clés API d'un prêt (D-30), scellées dans le volume privé du runner comme ses modèles : un
 * fichier par prêt, chiffré sous une clé dérivée de la master key, 0600, écrit atomiquement. Le
 * secret (32 octets) n'est jamais renvoyé ni journalisé : il ne sert qu'à vérifier le HMAC des
 * requêtes. Lecture, calcul et réécriture synchrones : aucune autre requête ne s'intercale.
 */
interface ApiKeyRecord {
  keyId: string;
  loanId: string;
  owner: string;
  secret: string;
  createdAt: number;
  revokedAt?: number;
}

interface SealedKeys {
  loanId: string;
  keys: ApiKeyRecord[];
}

/** Vue d'une clé pour la vérification d'une requête : le secret reste dans le runner. */
export interface ApiKeyMaterial {
  keyId: string;
  loanId: string;
  owner: string;
  secret: Buffer;
  createdAt: number;
  revokedAt?: number;
}

function assertIds(loanId: string, keyId: string): void {
  if (!MODEL_REF_ID_PATTERN.test(loanId)) throw new AppError("Identifiant de prêt invalide", 400);
  if (!API_KEY_ID_PATTERN.test(keyId)) throw new AppError("Identifiant de clé API invalide", 400);
}

function storeKey(loanId: string): Buffer {
  return deriveKey(getMasterKey(), `api-keys:v1:${loanId}`);
}

function validTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function readKeys(loanId: string): SealedKeys {
  const bytes = readPrivateFile(loanApiKeysPath(loanId), MAX_KEYS_BYTES);
  if (!bytes) return { loanId, keys: [] };
  try {
    const data = JSON.parse(decrypt(JSON.parse(bytes.toString("utf8")) as EncryptedPayload, storeKey(loanId)).toString()) as SealedKeys;
    if (data.loanId !== loanId || !Array.isArray(data.keys) || data.keys.length > MAX_RECORDS_PER_LOAN) throw new Error();
    for (const record of data.keys) {
      if (!record || record.loanId !== loanId || typeof record.keyId !== "string" || !API_KEY_ID_PATTERN.test(record.keyId)
        || typeof record.owner !== "string" || !/^0x[0-9a-f]{40}$/.test(record.owner)
        || typeof record.secret !== "string" || Buffer.from(record.secret, "base64url").length !== API_KEY_SECRET_BYTES
        || !validTime(record.createdAt) || (record.revokedAt !== undefined && !validTime(record.revokedAt))) throw new Error();
    }
    return data;
  } catch {
    throw new AppError("Registre de clés API indisponible", 503);
  }
}

function writeKeys(sealed: SealedKeys, replace: boolean): void {
  const bytes = Buffer.from(JSON.stringify(encrypt(Buffer.from(JSON.stringify(sealed)), storeKey(sealed.loanId))));
  if (bytes.length > MAX_KEYS_BYTES) throw new AppError("Registre de clés API plein", 409);
  writePrivateFile(loanApiKeysPath(sealed.loanId), bytes, replace);
}

function sameSecret(stored: string, candidate: Buffer): boolean {
  const left = Buffer.from(stored, "base64url");
  try {
    return left.length === candidate.length && timingSafeEqual(left, candidate);
  } finally {
    left.fill(0);
  }
}

/**
 * Enregistre une clé pour l'emprunteur `owner` du prêt. Idempotent : même `keyId` et même secret
 * ⇒ même réponse ; même `keyId` avec un autre secret, ou clé révoquée ⇒ 409. Au plus
 * `API_KEY_MAX_PER_LOAN` clés actives par prêt.
 */
export function registerApiKey(input: { loanId: string; keyId: string; owner: string; secret: Buffer; now?: number }): { keyId: string; createdAt: number } {
  assertIds(input.loanId, input.keyId);
  if (input.secret.length !== API_KEY_SECRET_BYTES) throw new AppError("Secret de clé API invalide", 400);
  const owner = canonicalSubject(input.owner);
  const sealed = readKeys(input.loanId);
  const existing = sealed.keys.find((record) => record.keyId === input.keyId);
  if (existing) {
    if (existing.owner !== owner || !sameSecret(existing.secret, input.secret)) {
      throw new AppError("Identifiant de clé API déjà utilisé", 409, "key_conflict");
    }
    if (existing.revokedAt !== undefined) throw new AppError("Clé API révoquée", 409, "key_revoked");
    return { keyId: existing.keyId, createdAt: existing.createdAt };
  }
  if (sealed.keys.filter((record) => record.revokedAt === undefined).length >= API_KEY_MAX_PER_LOAN) {
    throw new AppError("Limite de clés API actives atteinte pour ce prêt : révoque une clé d’abord", 409, "key_limit_reached");
  }
  if (sealed.keys.length >= MAX_RECORDS_PER_LOAN) throw new AppError("Registre de clés API plein", 409, "key_limit_reached");
  const createdAt = input.now ?? Date.now();
  const record: ApiKeyRecord = {
    keyId: input.keyId, loanId: input.loanId, owner, secret: input.secret.toString("base64url"), createdAt,
  };
  writeKeys({ loanId: input.loanId, keys: [...sealed.keys, record] }, sealed.keys.length > 0);
  return { keyId: record.keyId, createdAt };
}

/** Révocation par l'emprunteur. Idempotente : une clé déjà révoquée garde sa date. */
export function revokeApiKey(input: { loanId: string; keyId: string; owner: string; now?: number }): { keyId: string; revokedAt: number } {
  assertIds(input.loanId, input.keyId);
  const owner = canonicalSubject(input.owner);
  const sealed = readKeys(input.loanId);
  const existing = sealed.keys.find((record) => record.keyId === input.keyId);
  if (!existing) throw new AppError("Clé API inconnue", 404, "unknown_key");
  if (existing.owner !== owner) throw new AppError("Révocation réservée à l’emprunteur", 403);
  if (existing.revokedAt !== undefined) return { keyId: existing.keyId, revokedAt: existing.revokedAt };
  const revokedAt = input.now ?? Date.now();
  writeKeys({
    loanId: input.loanId,
    keys: sealed.keys.map((record) => record.keyId === input.keyId ? { ...record, revokedAt } : record),
  }, true);
  return { keyId: existing.keyId, revokedAt };
}

/** Clé `keyId` du prêt `loanId`, révoquée ou non ; `null` si elle n'appartient pas à ce prêt. */
export function loadApiKey(loanId: string, keyId: string): ApiKeyMaterial | null {
  if (!MODEL_REF_ID_PATTERN.test(loanId) || !API_KEY_ID_PATTERN.test(keyId)) return null;
  const record = readKeys(loanId).keys.find((candidate) => candidate.keyId === keyId);
  if (!record) return null;
  return {
    keyId: record.keyId, loanId: record.loanId, owner: record.owner, secret: Buffer.from(record.secret, "base64url"),
    createdAt: record.createdAt, ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  };
}
