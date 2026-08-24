import "server-only";
import { createPublicKey, verify as verifySignature, createHash } from "node:crypto";
import { deriveAddress, verify as verifyXrplSignature } from "ripple-keypairs";
import { AppError } from "@/lib/app-error";
import {
  parseDelegationMessage,
  runnerGrantMessage,
  runnerIntent,
  type AuthorizedRunnerOperation,
  type RunnerGrant,
  type RunnerGrantScope,
} from "./authorization-contract";
import { consumeRunnerReplay } from "./replay";

const MAX_DELEGATION_MS = 60 * 60 * 1000;
const MAX_GRANT_MS = 60_000;
const CLOCK_SKEW_MS = 30_000;

export interface ExpectedRunnerGrant extends RunnerGrantScope {
  operation: AuthorizedRunnerOperation;
  intentParts: readonly string[];
}

function decodeBase64Url(value: unknown, name: string, exactBytes?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 512) {
    throw new AppError(`${name} invalide`, 401);
  }
  const decoded = Buffer.from(value, "base64url");
  if (exactBytes !== undefined && decoded.length !== exactBytes) throw new AppError(`${name} invalide`, 401);
  return decoded;
}

export function hashRunnerIntent(parts: readonly string[]): string {
  return createHash("sha256").update(runnerIntent(parts)).digest("hex");
}

export interface ValidatedRunnerGrant {
  subject: string;
  replayId: string;
  expiresAt: number;
}

export function validateRunnerGrant(value: unknown, expected: ExpectedRunnerGrant): ValidatedRunnerGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("Autorisation runner manquante", 401);
  }
  const grant = value as RunnerGrant;
  const { delegation, payload } = grant;
  if (!delegation || !payload || payload.version !== 1 || payload.operation !== expected.operation) {
    throw new AppError("Autorisation runner invalide", 401);
  }

  const fields = parseDelegationMessage(delegation.message);
  const now = Date.now();
  if (
    !fields ||
    fields.address !== payload.subject ||
    fields.sessionPublicKey !== delegation.sessionPublicKey ||
    fields.network !== payload.network ||
    fields.issuedAt >= fields.expiresAt ||
    fields.issuedAt < now - MAX_DELEGATION_MS - CLOCK_SKEW_MS ||
    fields.issuedAt > now + CLOCK_SKEW_MS ||
    fields.expiresAt <= now ||
    fields.expiresAt - fields.issuedAt > MAX_DELEGATION_MS
  ) {
    throw new AppError("Délégation runner invalide ou expirée", 401);
  }

  const configuredOrigin = process.env.SIRIUS_APP_ORIGIN?.replace(/\/+$/, "");
  if (configuredOrigin && fields.origin !== configuredOrigin) {
    throw new AppError("Origine de délégation invalide", 401);
  }
  const expectedNetwork = process.env.XRPL_NETWORK || "testnet";
  if (fields.network !== expectedNetwork) throw new AppError("Réseau de délégation invalide", 401);

  let walletAddress: string;
  let walletSignatureValid = false;
  try {
    walletAddress = deriveAddress(delegation.walletPublicKey);
    walletSignatureValid = verifyXrplSignature(
      Buffer.from(delegation.message, "utf8").toString("hex"),
      delegation.walletSignature,
      delegation.walletPublicKey,
    );
  } catch {
    throw new AppError("Signature wallet de délégation invalide", 401);
  }
  if (!walletSignatureValid || walletAddress !== fields.address) {
    throw new AppError("Signature wallet de délégation invalide", 401);
  }

  if (
    payload.datasetId !== expected.datasetId ||
    payload.loanId !== expected.loanId ||
    payload.jobId !== expected.jobId ||
    payload.payloadHash !== hashRunnerIntent(expected.intentParts) ||
    !/^[A-Za-z0-9_-]{24}$/.test(payload.nonce) ||
    !Number.isSafeInteger(payload.issuedAt) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.issuedAt >= payload.expiresAt ||
    payload.issuedAt < now - MAX_GRANT_MS - CLOCK_SKEW_MS ||
    payload.issuedAt > now + CLOCK_SKEW_MS ||
    payload.expiresAt <= now ||
    payload.expiresAt - payload.issuedAt > MAX_GRANT_MS ||
    payload.expiresAt > fields.expiresAt
  ) {
    throw new AppError("Grant runner hors scope ou expiré", 401);
  }

  let sessionKey;
  try {
    sessionKey = createPublicKey({
      key: decodeBase64Url(delegation.sessionPublicKey, "Clé de session"),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new AppError("Clé de session runner invalide", 401);
  }
  if (
    sessionKey.asymmetricKeyType !== "ec" ||
    sessionKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new AppError("Clé de session runner invalide", 401);
  }
  let signatureValid = false;
  try {
    signatureValid = verifySignature(
      "sha256",
      Buffer.from(runnerGrantMessage(payload)),
      { key: sessionKey, dsaEncoding: "ieee-p1363" },
      decodeBase64Url(grant.signature, "Signature de grant", 64),
    );
  } catch {
    throw new AppError("Signature de grant invalide", 401);
  }
  if (!signatureValid) throw new AppError("Signature de grant invalide", 401);

  return {
    subject: payload.subject,
    replayId: `${payload.subject}:${payload.nonce}`,
    expiresAt: payload.expiresAt,
  };
}

export function verifyRunnerGrant(value: unknown, expected: ExpectedRunnerGrant): { subject: string } {
  const grant = validateRunnerGrant(value, expected);
  if (!consumeRunnerReplay("grant", grant.replayId, grant.expiresAt)) {
    throw new AppError("Grant runner déjà utilisé", 409);
  }

  return { subject: grant.subject };
}
