"use client";

import { useWalletStore } from "@/stores/wallet";
import {
  parseDelegationMessage,
  runnerGrantMessage,
  runnerIntent,
  type AuthorizedRunnerOperation,
  type RunnerDelegation,
  type RunnerGrant,
  type RunnerGrantScope,
} from "./authorization-contract";

const GRANT_TTL_MS = 60_000;
let pendingKey: CryptoKeyPair | null = null;
let active: { privateKey: CryptoKey; delegation: RunnerDelegation } | null = null;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function beginRunnerDelegation(): Promise<string> {
  active = null;
  pendingKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("spki", pendingKey.publicKey);
  return encodeBase64Url(new Uint8Array(publicKey));
}

export function activateRunnerDelegation(delegation: RunnerDelegation): void {
  if (!pendingKey) throw new Error("Clé de session runner absente");
  const fields = parseDelegationMessage(delegation.message);
  if (!fields || fields.sessionPublicKey !== delegation.sessionPublicKey) {
    throw new Error("Délégation runner invalide");
  }
  active = { privateKey: pendingKey.privateKey, delegation };
  pendingKey = null;
}

export function clearRunnerDelegation(): void {
  pendingKey = null;
  active = null;
}

export async function issueRunnerGrant(
  operation: AuthorizedRunnerOperation,
  scope: RunnerGrantScope,
  intentParts: readonly string[],
): Promise<RunnerGrant> {
  if (!active) {
    useWalletStore.getState().setAuthenticated(false);
    throw new Error("Réauthentifie ton wallet pour autoriser le runner");
  }
  const fields = parseDelegationMessage(active.delegation.message);
  const { address, network } = useWalletStore.getState();
  if (
    !fields ||
    fields.expiresAt <= Date.now() ||
    fields.address !== address ||
    fields.network !== network
  ) {
    clearRunnerDelegation();
    useWalletStore.getState().setAuthenticated(false);
    throw new Error("Délégation runner expirée — réauthentifie ton wallet");
  }

  const now = Date.now();
  const payload = {
    version: 1 as const,
    operation,
    subject: fields.address,
    network: fields.network,
    ...scope,
    payloadHash: await sha256(runnerIntent(intentParts)),
    nonce: encodeBase64Url(crypto.getRandomValues(new Uint8Array(18))),
    issuedAt: now,
    expiresAt: Math.min(now + GRANT_TTL_MS, fields.expiresAt),
  };
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    active.privateKey,
    new TextEncoder().encode(runnerGrantMessage(payload)),
  );
  return { delegation: active.delegation, payload, signature: encodeBase64Url(new Uint8Array(signature)) };
}
