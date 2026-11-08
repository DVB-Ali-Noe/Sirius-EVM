import "server-only";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { readBody } from "@/lib/http/body";
import { FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import { modelSelection, type ModelSelection } from "@/lib/models/registry";
import type { Loan } from "@/generated/prisma/client";
import { API_KEY_ID_PATTERN, type ApiModelInfo, type ApiPrediction, type ApiRemaining } from "@/lib/tee/contract";
import { apiInfoInRunner, apiPredictInRunner } from "@/lib/tee/runner-client";
import { assertApiAccessPaid, recordApiUsage } from "./api-keys";
import { EnclaveStarting, enclaveStartingBody, requireRunnerOrWake } from "./availability";
import { effectiveLoanFinalityTier } from "./finality-tier";
import { assertSignedPrediction, modelFeaturesFromRunner, parsePredictionFeatures } from "./prediction";
import { phalaDemoInstance } from "./self-training-access";

/**
 * API publique des modèles loués (D-30) : `POST /v1/models/<loanId>/predict` et
 * `GET /v1/models/<loanId>`. Requêtes signées HMAC par le client sous le secret de sa clé, scellé
 * dans l'enclave : Next relaie la requête brute (chemin public, méthode, en-têtes, corps exact) au
 * runner, qui seul vérifie la signature, l'anti-rejeu, le quota et signe la prédiction. Next ne peut
 * donc fabriquer aucun appel ; il filtre seulement ce qui ne mérite pas un aller-retour (clé inconnue
 * ou révoquée, prêt non servi, débit) et revalide la réponse avant de la rendre. CVM éteinte : un
 * appel qui a passé ces filtres la réveille et reçoit `503 enclave_starting` avec `Retry-After`.
 * Erreurs : `{ error: { code, message } }`, `code` stable (celui du runner quand il en donne un).
 */

/** Corps d'une prédiction : `{ "features": { ... } }`, au plus 16 Kio. */
export const API_BODY_MAX_BYTES = 16 * 1024;

const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^[0-9]{1,12}$/;
const LOAN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 120 requêtes par minute et par clé, prédiction et description confondues. */
const apiLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 120, maxGlobal: 6_000, maxTrackedKeys: 4_096 });

/** Refus après authentification par l'enclave : comptés dans le journal d'affichage de la clé. */
const AUTHENTICATED_REFUSALS: Record<string, true> = {
  quota_exceeded: true, invalid_features: true, rental_expired: true, api_not_available_for_profile: true, api_access_required: true,
};

const STATUS_CODES: Record<number, string> = {
  400: "invalid_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 408: "request_timeout",
  409: "conflict", 411: "invalid_request", 413: "payload_too_large", 415: "unsupported_media_type", 429: "rate_limited",
  502: "runner_error", 503: "runner_unavailable",
};

const noStore = { "cache-control": "no-store" };

export function apiErrorResponse(error: unknown): NextResponse {
  if (error instanceof EnclaveStarting) {
    const { body, headers } = enclaveStartingBody(error);
    return NextResponse.json(body, { status: 503, headers });
  }
  if (error instanceof AppError) {
    const code = error.code ?? STATUS_CODES[error.status] ?? (error.status >= 500 ? "runner_error" : "invalid_request");
    const headers: Record<string, string> = { ...noStore, ...(error.status === 429 && code === "rate_limited" ? { "retry-after": "60" } : {}) };
    return NextResponse.json({ error: { code, message: error.message } }, { status: error.status, headers });
  }
  console.error(`[api] erreur interne (${error instanceof Error ? error.name : typeof error})`);
  return NextResponse.json({ error: { code: "internal_error", message: "Erreur interne — réessaye." } }, { status: 500, headers: noStore });
}

interface SignedHeaders {
  keyId: string;
  timestamp: number;
  nonce: string;
  signature: string;
}

function signedHeaders(req: Request): SignedHeaders {
  const keyId = req.headers.get("sirius-key") ?? "";
  const timestamp = req.headers.get("sirius-timestamp") ?? "";
  const nonce = req.headers.get("sirius-nonce") ?? "";
  const signature = req.headers.get("sirius-signature") ?? "";
  if (!API_KEY_ID_PATTERN.test(keyId) || !TIMESTAMP.test(timestamp) || !NONCE.test(nonce) || !SIGNATURE.test(signature)) {
    throw new AppError("En-têtes Sirius-Key, Sirius-Timestamp, Sirius-Nonce et Sirius-Signature requis", 401, "invalid_signature");
  }
  return { keyId, timestamp: Number(timestamp), nonce, signature };
}

type ServedLoan = Loan & { runnerReceipt: string; settleTxHash: string; model: ModelSelection };

/**
 * Prêt servi par l'API pour la clé `keyId` : clé connue de ce prêt et non révoquée, prêt d'origine
 * réglé, location non échue d'après l'échéance enregistrée, puis pass d'accès API couvrant `now`
 * (D-32) : une clé sans journée payée ne réveille jamais l'enclave. L'enclave refait tous ces contrôles.
 */
async function servedLoan(loanId: string, keyId: string, now: number): Promise<ServedLoan> {
  if (phalaDemoInstance() || !LOAN_ID.test(loanId)) throw new AppError("Modèle introuvable", 404, "not_found");
  const key = await prisma.apiKey.findUnique({ where: { id: keyId }, select: { loanId: true, revokedAt: true } });
  if (!key || key.loanId !== loanId) throw new AppError("Clé API inconnue", 401, "unknown_key");
  if (key.revokedAt) throw new AppError("Clé API révoquée", 401, "key_revoked");
  const loan = await prisma.loan.findUnique({ where: { id: loanId } });
  if (!loan || loan.extendsLoanId || loan.packForLoanId) throw new AppError("Modèle introuvable", 404, "not_found");
  const model = modelSelection(loan.modelId, loan.modelVersion);
  if (loan.status !== "SETTLED" || loan.finalityReview || !loan.runnerReceipt || !loan.settleTxHash || !model) {
    throw new AppError("Modèle indisponible", 409, "model_unavailable");
  }
  if (loan.rentalExpiresAt && now >= loan.rentalExpiresAt.getTime()) {
    throw new AppError("Location expirée : l’emprunteur doit la prolonger", 403, "rental_expired");
  }
  assertApiAccessPaid(loan, now);
  return { ...loan, runnerReceipt: loan.runnerReceipt, settleTxHash: loan.settleTxHash, model };
}

function assertRemaining(value: unknown): ApiRemaining {
  const remaining = value as ApiRemaining | null;
  const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!remaining || typeof remaining !== "object" || !count(remaining.today) || !count(remaining.credits)) {
    throw new AppError("Réponse de l’enclave invalide", 502);
  }
  return { today: remaining.today, credits: remaining.credits };
}

function expiryIso(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new AppError("Réponse de l’enclave invalide", 502);
  return new Date(value).toISOString();
}

/**
 * Contrôles communs, puis appel du runner. Les refus authentifiés (et les appels servis, par
 * l'appelant) alimentent le journal d'affichage de la clé ; une erreur de signature, jamais.
 *
 * Réveil (option 1 du 8 novembre 2026) : seulement après les en-têtes, le débit par clé et
 * `servedLoan` (clé existante de ce prêt, non révoquée, location réglée et non échue). La signature
 * HMAC ne se vérifie que dans l'enclave : borne acceptée, quiconque détient un `keyId` valide peut
 * garder la CVM allumée pour cette location, comme le faisait D-30 avant cette option, et jamais
 * au-delà de l'échéance de la location ni après la révocation de la clé.
 */
async function relay<T>(req: Request, loanId: string, call: (loan: ServedLoan, headers: SignedHeaders) => Promise<T>) {
  const headers = signedHeaders(req);
  if (!apiLimiter.consume(`key:${headers.keyId}`)) throw new AppError("Trop de requêtes pour cette clé — réessaie dans une minute", 429, "rate_limited");
  const loan = await servedLoan(loanId, headers.keyId, Date.now());
  await requireRunnerOrWake();
  try {
    return { loan, headers, result: await call(loan, headers) };
  } catch (error) {
    if (error instanceof AppError && error.code && AUTHENTICATED_REFUSALS[error.code]) await recordApiUsage(headers.keyId, "refused");
    throw error;
  }
}

/** Corps brut exact (signé par le client), en UTF-8 strict : il est relayé octet pour octet. */
async function rawBody(req: Request): Promise<string> {
  const bytes = await readBody(req, API_BODY_MAX_BYTES);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new AppError("Corps de requête invalide (UTF-8 attendu)", 400, "invalid_request");
  }
}

function bodyFeatures(body: string): Record<string, number> {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { parsed = null; }
  const object = parsed as Record<string, unknown> | null;
  const features = object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).length === 1
    ? parsePredictionFeatures(object.features) : null;
  if (!features) throw new AppError("Corps attendu : { \"features\": { nom: nombre, … } }", 400, "invalid_features");
  return features;
}

export async function handleApiPredict(req: Request, loanId: string): Promise<NextResponse> {
  try {
    const { loan, headers, result } = await relay(req, loanId, async (served, signed) => {
      const body = await rawBody(req);
      const features = bodyFeatures(body);
      const prediction: ApiPrediction = await apiPredictInRunner({
        loanId: served.id, ...signed, method: "POST", path: `/v1/models/${served.id}/predict`, body,
        loanReceipt: served.runnerReceipt, settleTxHash: served.settleTxHash, finalityTier: effectiveLoanFinalityTier(served.finalityTier),
      });
      return { prediction, features };
    });
    const signed = await assertSignedPrediction(result.prediction, {
      ref: { kind: "loan", id: loan.id }, modelId: loan.model.modelId, modelVersion: loan.model.modelVersion,
      subject: loan.borrower, features: result.features, sessionRevision: 0,
    });
    const remaining = assertRemaining(result.prediction.remaining);
    const expiresAt = expiryIso(result.prediction.expiresAt);
    await recordApiUsage(headers.keyId, "call");
    return NextResponse.json({
      [signed.outputKind]: signed.output,
      outputKind: signed.outputKind,
      counter: signed.counter,
      remaining,
      expiresAt,
      modelId: signed.modelId,
      modelVersion: signed.modelVersion,
      signature: signed.signature,
      signer: signed.signer,
      domain: signed.domain,
      signedMessage: signed.signedMessage,
    }, { headers: noStore });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function handleApiInfo(req: Request, loanId: string): Promise<NextResponse> {
  try {
    const { loan, result } = await relay(req, loanId, (served, signed) => apiInfoInRunner({
      loanId: served.id, ...signed, method: "GET", path: `/v1/models/${served.id}`, body: "",
      loanReceipt: served.runnerReceipt, settleTxHash: served.settleTxHash, finalityTier: effectiveLoanFinalityTier(served.finalityTier),
    }));
    const info = result as ApiModelInfo;
    if (info.loanId !== loan.id || info.modelId !== loan.model.modelId || info.modelVersion !== loan.model.modelVersion) {
      throw new AppError("Réponse de l’enclave invalide", 502);
    }
    return NextResponse.json({
      loanId: loan.id,
      modelId: info.modelId,
      modelVersion: info.modelVersion,
      features: modelFeaturesFromRunner(info.features),
      expiresAt: expiryIso(info.expiresAt),
      remaining: assertRemaining(info.remaining),
    }, { headers: noStore });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
