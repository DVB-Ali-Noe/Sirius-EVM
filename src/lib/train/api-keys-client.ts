"use client";

import { issueRunnerGrant } from "@/lib/runner/authorization-client";
import { apiKeyEnvelopeSha256, encryptApiKeySecretForRunner } from "@/lib/tee/ingress-client";
import type { DatasetIngressKey } from "@/lib/tee/contract";
import { responseError } from "./enclave-wait";

/** Clé API telle que la renvoie `GET /api/loans/[id]/api-keys` : jamais de secret. */
export interface ApiKeySummary {
  keyId: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  calls30d: number;
}

export type EnclavePhase = "stopped" | "starting" | "running" | "stopping";

export interface ApiKeysOverview {
  keys: ApiKeySummary[];
  callsPerDay: number;
  /** Chiffres indicatifs côté Next : le compteur faisant foi est dans l'enclave. */
  usage: { apiCallsToday: number; creditsPurchased: number };
  enclave: EnclavePhase;
}

export interface CreatedApiKey {
  keyId: string;
  name: string;
  createdAt: string;
  /** `sk_live_<keyId>.<secret>` : affiché une seule fois, jamais stocké par Sirius en clair. */
  token: string;
}

export const API_KEY_NAME_MAX_LENGTH = 64;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Identifiant (16 octets) et secret (32 octets) tirés dans le navigateur, en base64url. */
export function generateApiKeyMaterial(random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): {
  keyId: string;
  secret: string;
  token: string;
} {
  const keyId = encodeBase64Url(random(new Uint8Array(16)));
  const secret = encodeBase64Url(random(new Uint8Array(32)));
  return { keyId, secret, token: `sk_live_${keyId}.${secret}` };
}

const keysPath = (loanId: string) => `/api/loans/${encodeURIComponent(loanId)}/api-keys`;

export async function listApiKeys(loanId: string, signal?: AbortSignal): Promise<ApiKeysOverview> {
  const response = await fetch(keysPath(loanId), { signal });
  if (!response.ok) throw await responseError(response, "Chargement des clés API impossible");
  return await response.json() as ApiKeysOverview;
}

export type ApiKeyCreationStep = "preparing" | "sealing" | "signing" | "registering";

/**
 * Crée une clé API pour le prêt `loanId`. Première requête sans secret : contrôle d'accès et clé
 * d'ingestion de l'enclave (503 `enclave_starting` tant qu'elle démarre : rien n'est créé, relance
 * sans risque). Puis génération locale, chiffrement du secret pour l'enclave, grant
 * `register-api-key` lié à l'empreinte de l'enveloppe, et enregistrement. Le secret ne quitte le
 * navigateur que chiffré pour l'enclave.
 */
export async function createApiKey(input: {
  loanId: string;
  name: string;
  onStep?: (step: ApiKeyCreationStep) => void;
}): Promise<CreatedApiKey> {
  const name = input.name.trim();
  if (!name || name.length > API_KEY_NAME_MAX_LENGTH) throw new Error("Nom de clé invalide (1 à 64 caractères)");
  input.onStep?.("preparing");
  const prepared = await fetch(keysPath(input.loanId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!prepared.ok) throw await responseError(prepared, "Création de la clé API échouée");
  const { ingressKey } = await prepared.json() as { ingressKey?: DatasetIngressKey };
  if (!ingressKey) throw new Error("Clé d’ingestion de l’enclave absente");
  const { keyId, secret, token } = generateApiKeyMaterial();
  input.onStep?.("sealing");
  const envelope = await encryptApiKeySecretForRunner(secret, keyId, ingressKey);
  input.onStep?.("signing");
  const authorization = await issueRunnerGrant("register-api-key", { loanId: input.loanId }, [
    input.loanId,
    keyId,
    await apiKeyEnvelopeSha256(envelope),
  ]);
  input.onStep?.("registering");
  const response = await fetch(keysPath(input.loanId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyId, name, envelope, authorization }),
  });
  if (!response.ok) throw await responseError(response, "Création de la clé API échouée");
  const created = await response.json() as { keyId: string; name: string; createdAt: string };
  if (created.keyId !== keyId) throw new Error("Création de la clé API échouée");
  return { keyId, name: created.name, createdAt: created.createdAt, token };
}

export async function revokeApiKey(input: { loanId: string; keyId: string }): Promise<{ keyId: string; revokedAt: string }> {
  const authorization = await issueRunnerGrant("revoke-api-key", { loanId: input.loanId }, [input.loanId, input.keyId]);
  const response = await fetch(`${keysPath(input.loanId)}/${encodeURIComponent(input.keyId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authorization }),
  });
  if (!response.ok) throw await responseError(response, "Révocation de la clé API échouée");
  return await response.json() as { keyId: string; revokedAt: string };
}
