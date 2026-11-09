import "server-only";
import { prisma, serializableTransaction } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { addressesEqual } from "@/lib/evm/address";
import { billingEnabled, billingPolicy } from "@/lib/billing/config";
import {
  API_ACCESS_NOT_FOR_SALE_CODE, API_ACCESS_REQUIRED, API_ACCESS_REQUIRED_CODE, API_KEY_MAX_PER_LOAN, API_KEY_PENDING, API_KEY_UNCONFIRMED, apiAccessComputeAmount, apiAccessDatasetAmount,
  apiAccessDaysFor, AUTO_API_KEY_EXISTS, AUTO_API_KEY_EXISTS_CODE, AUTO_API_KEY_UNCONFIRMED, isApiAccessDays, RENTAL_API_ACCESS_NOT_FOR_SALE,
} from "@/lib/billing/api-pricing";
import { resolveUsdcDecimals } from "@/lib/evm/networks";
import { isServedModelFingerprint, type ModelId } from "@/lib/models/registry";
import { hashRunnerIntent } from "@/lib/runner/authorization";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { assertCurrentRunner } from "@/lib/runner/provenance";
import { API_KEY_ID_PATTERN, type ApiKeySecretEnvelope, type DatasetIngressKey } from "@/lib/tee/contract";
import { datasetIngressKeyInRunner, registerApiKeyInRunner, revokeApiKeyInRunner } from "@/lib/tee/runner-client";
import { requireAcceptedKyb } from "./access";
import { requireRunnerOrWake, runnerPhase, type RunnerPhase } from "./availability";
import { effectiveLoanFinalityTier } from "./finality-tier";
import { includesApiAccess, loanRentalExpiry, RENTAL_EXPIRED } from "./rental";

/**
 * Clés API d'un prêt loué (D-30), côté Next. Le secret n'existe que dans le navigateur (affiché une
 * fois) et scellé dans l'enclave : Next ne voit que l'enveloppe chiffrée qu'il relaie et ne garde
 * que l'affichage (nom, dates, compteurs indicatifs). Toute création ou révocation passe par le
 * runner, sur grant wallet de l'emprunteur ; une nouvelle clé a sa ligne réservée avant le
 * scellement (voir `registerLoanApiKey`), une révocation n'est datée qu'après la réponse du runner.
 */

export const API_UNAVAILABLE_LINEAR = "API indisponible pour la régression linéaire (le modèle serait reconstructible)";
export const API_UNAVAILABLE_PROFILE = "API indisponible pour ce profil de modèle";
export const API_PROFILE_CODE = "api_not_available_for_profile";
/** Toute location inclut l'API (D-32) : un profil sans quota API dans le tarif n'est pas louable. */
export const RENTAL_API_UNAVAILABLE_PROFILE = "Location indisponible : le tarif en vigueur n’ouvre pas l’API pour ce profil, or toute location inclut l’accès API";

const KEY_NAME_MAX = 64;
const USAGE_DAYS = 30;
const DAY_MS = 86_400_000;
/**
 * Âge au-delà duquel une réservation que l'enclave ne connaît pas est réputée jamais scellée : délai
 * du client runner (60 s, `runner-client.ts`) plus une marge pour un scellement encore en cours.
 */
const KEY_SEALING_SETTLED_MS = 2 * 60_000;

/**
 * Quota quotidien inclus d'un profil (`apiCallsPerDay` de la politique), `null` sans API : profil
 * absent de la politique, régression linéaire (jamais, D-27), facturation v7 inactive ou politique
 * illisible ici. Affichage et contrôles préalables seulement : l'enclave applique la sienne.
 */
export function loanApiCallsPerDay(modelId: string, env: Record<string, string | undefined> = process.env): number | null {
  if (modelId === "linear_regression") return null;
  try {
    if (!billingEnabled()) return null;
    const calls = billingPolicy(env).apiCallsPerDay?.[modelId as ModelId];
    return typeof calls === "number" && Number.isSafeInteger(calls) && calls >= 1 ? calls : null;
  } catch {
    return null;
  }
}

/**
 * Tarif journalier de l'accès API (`apiAccessDailyComputeAmount`, D-32), `null` s'il n'est pas en
 * vente : champ absent, facturation v7 inactive ou politique illisible ici. Affichage et refus
 * préalables seulement : l'enclave applique le tarif qu'elle signe.
 */
export function loanApiAccessDailyFee(env: Record<string, string | undefined> = process.env): string | null {
  try {
    if (!billingEnabled()) return null;
    return billingPolicy(env).apiAccessDailyComputeAmount ?? null;
  } catch {
    return null;
  }
}

/**
 * Accès API d'un NOUVEL emprunt (décision du 8 novembre 2026, D-32) : toute location l'inclut,
 * jours loués × tarif journalier, sans option pour s'en passer. Renvoie ce tarif journalier, ou
 * `null` quand l'API n'existe pas pour cet emprunt : régression linéaire (jamais d'API, D-27) ou
 * facturation v7 inactive (escrow v6 hérité, sans devis). Tout autre profil sans quota
 * `apiCallsPerDay` ou un tarif sans `apiAccessDailyComputeAmount` refuse la location (409) :
 * jamais de location sans API, jamais d'API gratuite. Politique illisible ici : 503.
 */
export function newRentalApiAccessDailyFee(modelId: string, env: Record<string, string | undefined> = process.env): string | null {
  if (modelId === "linear_regression" || !billingEnabled()) return null;
  const policy = billingPolicy(env);
  const calls = policy.apiCallsPerDay?.[modelId as ModelId];
  if (typeof calls !== "number" || !Number.isSafeInteger(calls) || calls < 1) {
    throw new AppError(RENTAL_API_UNAVAILABLE_PROFILE, 409, API_PROFILE_CODE);
  }
  const fee = policy.apiAccessDailyComputeAmount;
  if (fee === undefined) throw new AppError(RENTAL_API_ACCESS_NOT_FOR_SALE, 409, API_ACCESS_NOT_FOR_SALE_CODE);
  return fee;
}

/** Refus de Next, avant tout réveil de l'enclave, d'une API dont aucun pass ne couvre `now` (D-32). */
export function assertApiAccessPaid(loan: { apiPaidUntil: Date | null }, now = Date.now()): void {
  if (!loan.apiPaidUntil || now >= loan.apiPaidUntil.getTime()) throw new AppError(API_ACCESS_REQUIRED, 403, API_ACCESS_REQUIRED_CODE);
}

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface ApiLoanOptions {
  /** Création d'une clé, achat d'appels : la location doit être en cours. La liste reste lisible après. */
  requireActiveRental: boolean;
  now?: number;
}

/**
 * Prêt d'origine réglé de `borrower`, à modèle servi et dont le profil a une API. Refus explicites :
 * autre compte (403), prolongation ou pack (409), règlement non confirmé (409), linéaire ou profil
 * sans quota (409 `api_not_available_for_profile`), location échue (403 `rental_expired`).
 */
export async function assertApiLoan(loanId: string, borrower: string, options: ApiLoanOptions) {
  const loan = await prisma.loan.findUnique({ where: { id: loanId } });
  if (!loan) throw new AppError("Loan introuvable", 404);
  if (!addressesEqual(loan.borrower, borrower)) throw new AppError("Accès refusé : emprunt d’un autre compte", 403);
  if (loan.extendsLoanId || loan.packForLoanId) throw new AppError("Prolongation ou pack d’appels : utilise le prêt d’origine", 409);
  if (loan.status !== "SETTLED" || loan.finalityReview || !loan.runnerReceipt || !loan.settleTxHash) {
    throw new AppError("Règlement du prêt non confirmé", 409);
  }
  if (loan.modelId === "linear_regression") throw new AppError(API_UNAVAILABLE_LINEAR, 409, API_PROFILE_CODE);
  const callsPerDay = loanApiCallsPerDay(loan.modelId);
  if (callsPerDay === null) throw new AppError(API_UNAVAILABLE_PROFILE, 409, API_PROFILE_CODE);
  if (!isServedModelFingerprint(loan.modelCid)) throw new AppError("Modèle indisponible", 409);
  const expiresAt = await loanRentalExpiry(loan);
  if (!expiresAt) throw new AppError("Prêt sans durée de location : API indisponible", 409);
  if (options.requireActiveRental && (options.now ?? Date.now()) >= expiresAt.getTime()) {
    throw new AppError(RENTAL_EXPIRED, 403, "rental_expired");
  }
  return {
    ...loan, runnerReceipt: loan.runnerReceipt, settleTxHash: loan.settleTxHash, rentalExpiresAt: expiresAt, callsPerDay,
    apiAccessDailyFee: loanApiAccessDailyFee(),
  };
}

export interface ApiKeyView {
  keyId: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  calls30d: number;
}

export interface LoanApiKeys {
  keys: ApiKeyView[];
  callsPerDay: number;
  /** Indicatif (journal d'affichage) : le quota et les crédits font foi dans l'enclave. */
  usage: { apiCallsToday: number; creditsPurchased: number };
  /**
   * Accès API payé au jour (D-32). `dailyFee` nul : pas en vente. `paid` : un pass couvre l'instant
   * de la lecture. `daysToBuy` et `price` (total atomique, part fournisseur comprise) : estimation
   * du prochain pass jusqu'à l'échéance, le devis de l'enclave faisant foi ; `0` et `null` quand la
   * location est couverte ou échue.
   */
  apiAccess: {
    dailyFee: string | null; paidUntil: string | null; paid: boolean; rentalExpiresAt: string; daysToBuy: number; price: string | null;
    /** API incluse à l'emprunt (D-32). */
    included: boolean;
  };
  enclave: RunnerPhase;
}

/** Clés du prêt (sans secret), appels des 30 derniers jours, crédits achetés et état de la CVM. */
export async function listLoanApiKeys(loanId: string, borrower: string, now = new Date()): Promise<LoanApiKeys> {
  const loan = await assertApiLoan(loanId, borrower, { requireActiveRental: false, now: now.getTime() });
  const { callsPerDay, apiAccessDailyFee: dailyFee } = loan;
  const daysToBuy = apiAccessDaysFor(loan.rentalExpiresAt.getTime(), loan.apiPaidUntil?.getTime() ?? null, now.getTime());
  const today = utcDay(now);
  const since = utcDay(new Date(now.getTime() - (USAGE_DAYS - 1) * DAY_MS));
  const [keys, usage, packs, enclave] = await Promise.all([
    prisma.apiKey.findMany({ where: { loanId }, orderBy: { createdAt: "asc" } }),
    prisma.apiUsageDay.findMany({ where: { key: { loanId }, day: { gte: since } }, select: { keyId: true, day: true, calls: true } }),
    prisma.loan.findMany({ where: { packForLoanId: loanId, status: "SETTLED", callPack: { not: null } }, select: { callPack: true } }),
    runnerPhase(),
  ]);
  const calls30d = new Map<string, number>();
  let apiCallsToday = 0;
  for (const row of usage) {
    calls30d.set(row.keyId, (calls30d.get(row.keyId) ?? 0) + row.calls);
    if (row.day === today) apiCallsToday += row.calls;
  }
  return {
    keys: keys.map((key) => ({
      keyId: key.id, name: key.name, createdAt: key.createdAt.toISOString(),
      revokedAt: key.revokedAt?.toISOString() ?? null, lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
      calls30d: calls30d.get(key.id) ?? 0,
    })),
    callsPerDay,
    usage: { apiCallsToday, creditsPurchased: packs.reduce((sum, pack) => sum + (pack.callPack ?? 0), 0) },
    apiAccess: {
      dailyFee, paidUntil: loan.apiPaidUntil?.toISOString() ?? null, paid: Boolean(loan.apiPaidUntil && loan.apiPaidUntil > now),
      included: includesApiAccess(loan.billingQuote),
      rentalExpiresAt: loan.rentalExpiresAt.toISOString(), daysToBuy,
      price: dailyFee && isApiAccessDays(daysToBuy)
        ? (BigInt(apiAccessComputeAmount(dailyFee, daysToBuy)) + BigInt(apiAccessDatasetAmount(resolveUsdcDecimals()))).toString()
        : null,
    },
    enclave,
  };
}

/**
 * Première étape de la création : contrôles d'accès, réveil de la CVM si besoin (503), puis clé
 * d'ingestion de l'enclave pour que le navigateur y chiffre le secret. `auto` (clé créée d'office,
 * D-33) : refus anticipé, sans réveil, si le prêt a déjà une clé ; la garde qui fait foi est celle de
 * `registerLoanApiKey`.
 */
export async function prepareLoanApiKey(loanId: string, borrower: string, auto = false): Promise<{ ingressKey: DatasetIngressKey }> {
  const loan = await assertApiLoan(loanId, borrower, { requireActiveRental: true });
  assertApiAccessPaid(loan);
  if (auto && await prisma.apiKey.count({ where: { loanId } }) > 0) throw new AppError(AUTO_API_KEY_EXISTS, 409, AUTO_API_KEY_EXISTS_CODE);
  await assertKeyCapacity(loanId);
  await requireRunnerOrWake();
  await assertCurrentRunner(loan);
  return { ingressKey: await datasetIngressKeyInRunner() };
}

async function assertKeyCapacity(loanId: string, keyId?: string, db: Pick<typeof prisma, "apiKey"> = prisma): Promise<void> {
  const active = await db.apiKey.count({ where: { loanId, revokedAt: null, ...(keyId ? { id: { not: keyId } } : {}) } });
  if (active >= API_KEY_MAX_PER_LOAN) {
    throw new AppError(`Au plus ${API_KEY_MAX_PER_LOAN} clés API actives par prêt : révoque une clé d’abord`, 409, "key_limit_reached");
  }
}

export function parseApiKeyName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  // Caractères de contrôle exclus : le nom s'affiche tel quel.
  if (!name || name.length > KEY_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AppError(`Nom de clé invalide (1 à ${KEY_NAME_MAX} caractères)`, 400);
  }
  return name;
}

export function parseApiKeyId(value: unknown): string {
  if (typeof value !== "string" || !API_KEY_ID_PATTERN.test(value)) throw new AppError("Identifiant de clé invalide", 400);
  return value;
}

/** Enveloppe relayée telle quelle à l'enclave : exactement les cinq champs signés dans le grant. */
export function parseApiKeyEnvelope(value: unknown): ApiKeySecretEnvelope {
  const fields = ["version", "ephemeralPublicKey", "salt", "iv", "ciphertext"] as const;
  const envelope = value as Record<string, unknown> | null;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || Object.keys(envelope).length !== fields.length
    || envelope.version !== 1
    || fields.slice(1).some((field) => typeof envelope[field] !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(envelope[field] as string))) {
    throw new AppError("Enveloppe de clé invalide", 400);
  }
  return {
    version: 1, ephemeralPublicKey: envelope.ephemeralPublicKey as string, salt: envelope.salt as string,
    iv: envelope.iv as string, ciphertext: envelope.ciphertext as string,
  };
}

export interface RegisterApiKeyInput {
  loanId: string;
  borrower: string;
  keyId: string;
  name: string;
  envelope: ApiKeySecretEnvelope;
  authorization: RunnerGrant;
  /** Clé créée d'office après le règlement (D-33) : refusée si le prêt a déjà une clé, même révoquée. */
  auto?: boolean;
}

/**
 * Scellement de la clé dans l'enclave (`register-api-key`, idempotent : même `keyId` et même
 * secret ⇒ même réponse), puis date d'enregistrement sur la ligne d'affichage. Un `keyId` déjà pris
 * par un autre prêt est refusé.
 *
 * Toute nouvelle clé, d'office (`auto`) ou manuelle, a sa ligne réservée AVANT le scellement, dans
 * une transaction sérialisable qui vérifie la capacité (5 clés actives) et, pour une clé d'office,
 * que le prêt n'a aucune clé (active ou révoquée) : deux appareils ne scellent jamais deux clés
 * d'office, le second reçoit `409 api_key_auto_exists`. Refus net de l'enclave (4xx) : rien n'est
 * scellé, la réservation est retirée. Réponse perdue ou douteuse (réseau, 5xx, réponse illisible) :
 * l'enclave a pu sceller la clé, la ligne reste donc (elle compte dans la capacité, bloque une
 * seconde clé d'office et se révoque depuis le panneau, l'enclave répondant `unknown_key` si rien
 * n'a été scellé) et l'erreur remonte. Sans cette réservation (audit A, F4), une clé scellée sans
 * ligne n'était ni listée ni révocable et occupait une place dans la limite de l'enclave.
 */
export async function registerLoanApiKey(input: RegisterApiKeyInput) {
  const loan = await assertApiLoan(input.loanId, input.borrower, { requireActiveRental: true });
  assertApiAccessPaid(loan);
  const existing = await prisma.apiKey.findUnique({ where: { id: input.keyId } });
  if (existing && existing.loanId !== input.loanId) throw new AppError("Identifiant de clé déjà utilisé", 409, "key_conflict");
  if (existing?.revokedAt) throw new AppError("Clé API révoquée", 409, "key_revoked");
  if (!existing) await assertKeyCapacity(input.loanId, input.keyId);
  await requireAcceptedKyb(loan.borrower);
  await requireRunnerOrWake();
  await assertCurrentRunner(loan);
  const owner = loan.borrower.toLowerCase();
  const reserved = !existing;
  if (reserved) {
    await serializableTransaction(async (tx) => {
      if (input.auto === true && await tx.apiKey.count({ where: { loanId: loan.id } }) > 0) {
        throw new AppError(AUTO_API_KEY_EXISTS, 409, AUTO_API_KEY_EXISTS_CODE);
      }
      await assertKeyCapacity(loan.id, input.keyId, tx);
      await tx.apiKey.create({ data: { id: input.keyId, loanId: loan.id, owner, name: input.name, revokedAt: null, lastUsedAt: null } });
    });
  }
  let sealed: { keyId: string; createdAt: number };
  try {
    sealed = await registerApiKeyInRunner({
      loanId: loan.id, keyId: input.keyId, envelope: input.envelope, loanReceipt: loan.runnerReceipt,
      settleTxHash: loan.settleTxHash, authorization: input.authorization, finalityTier: effectiveLoanFinalityTier(loan.finalityTier),
    });
    if (sealed.keyId !== input.keyId || !Number.isSafeInteger(sealed.createdAt) || sealed.createdAt <= 0) {
      throw new AppError("Réponse d’enregistrement de clé invalide", 502);
    }
  } catch (error) {
    if (!reserved) throw error;
    if (error instanceof AppError && error.status >= 400 && error.status < 500) {
      // Refus de l'enclave : rien de scellé, le secret n'a pas été affiché.
      await prisma.apiKey.deleteMany({ where: { id: input.keyId, loanId: loan.id, lastUsedAt: null } });
      throw error;
    }
    throw new AppError(input.auto === true ? AUTO_API_KEY_UNCONFIRMED : API_KEY_UNCONFIRMED, error instanceof AppError ? error.status : 503);
  }
  if (!reserved) return { keyId: existing.id, name: existing.name, createdAt: existing.createdAt.toISOString() };
  const key = await prisma.apiKey.update({ where: { id: input.keyId }, data: { createdAt: new Date(sealed.createdAt) } });
  return { keyId: key.id, name: key.name, createdAt: key.createdAt.toISOString() };
}

export interface RevokeApiKeyInput {
  loanId: string;
  borrower: string;
  keyId: string;
  authorization: RunnerGrant;
}

/**
 * Révocation dans l'enclave (`revoke-api-key`, idempotente), puis date locale. Elle passe toujours
 * par le runner : une clé marquée révoquée ici mais encore active dans l'enclave resservirait après
 * une prolongation. CVM éteinte : réveil demandé et 503. Clé inconnue de l'enclave (`404 unknown_key`) :
 * réservation d'une clé jamais scellée (réponse perdue au scellement) ; rien n'est actif dans
 * l'enclave, la ligne est donc marquée révoquée maintenant, mais seulement si la réservation date
 * de plus de `KEY_SEALING_SETTLED_MS` : plus jeune, le scellement peut encore aboutir dans l'enclave
 * (revue de la PR #157), la révocation est refusée en `409 key_pending` sans rien marquer.
 *
 * Avant tout réveil (audit E, F1) : le grant, déjà authentifié par la route, doit viser cette
 * révocation (`revoke-api-key`, ce prêt, intention `[loanId, keyId]`), comme l'exigera l'enclave ;
 * sans nonce consommé ici. Un grant d'une autre opération ne réveille donc rien. Location échue (ou
 * sans échéance connue) : le réveil dépense le budget du compte (`wakeSubject`), comme une
 * publication ou un devis, pour qu'une clé jamais révoquée ne garde pas la CVM allumée après la location.
 */
export async function revokeLoanApiKey(input: RevokeApiKeyInput) {
  const loan = await prisma.loan.findUnique({ where: { id: input.loanId }, select: { id: true, borrower: true, rentalExpiresAt: true } });
  if (!loan) throw new AppError("Loan introuvable", 404);
  if (!addressesEqual(loan.borrower, input.borrower)) throw new AppError("Accès refusé : emprunt d’un autre compte", 403);
  const key = await prisma.apiKey.findUnique({ where: { id: input.keyId } });
  if (!key || key.loanId !== loan.id) throw new AppError("Clé API introuvable", 404);
  if (key.revokedAt) return { keyId: key.id, revokedAt: key.revokedAt.toISOString() };
  const scope = input.authorization?.payload;
  if (!scope || scope.operation !== "revoke-api-key" || scope.loanId !== loan.id || scope.datasetId !== undefined
    || scope.jobId !== undefined || scope.demoSessionRevision !== undefined || scope.payloadHash !== hashRunnerIntent([loan.id, key.id])) {
    throw new AppError("Grant runner hors scope ou expiré", 401);
  }
  const rentalOver = !loan.rentalExpiresAt || Date.now() >= loan.rentalExpiresAt.getTime();
  await requireRunnerOrWake(rentalOver ? { wakeSubject: loan.borrower } : {});
  let revoked: { keyId: string; revokedAt: number };
  try {
    revoked = await revokeApiKeyInRunner({ loanId: loan.id, keyId: key.id, authorization: input.authorization });
  } catch (error) {
    if (!(error instanceof AppError && error.status === 404 && error.code === "unknown_key")) throw error;
    if (Date.now() - key.createdAt.getTime() < KEY_SEALING_SETTLED_MS) throw new AppError(API_KEY_PENDING, 409, "key_pending");
    revoked = { keyId: key.id, revokedAt: Date.now() };
  }
  if (revoked.keyId !== key.id || !Number.isSafeInteger(revoked.revokedAt) || revoked.revokedAt <= 0) {
    throw new AppError("Réponse de révocation invalide", 502);
  }
  const revokedAt = new Date(revoked.revokedAt);
  await prisma.apiKey.updateMany({ where: { id: key.id, revokedAt: null }, data: { revokedAt } });
  const stored = await prisma.apiKey.findUnique({ where: { id: key.id }, select: { revokedAt: true } });
  return { keyId: key.id, revokedAt: (stored?.revokedAt ?? revokedAt).toISOString() };
}

/**
 * Journal d'affichage d'un appel API authentifié : servi (`call`, et dernière utilisation) ou refusé
 * après authentification (`refused` : quota, variables, location). Au mieux : jamais bloquant.
 */
export async function recordApiUsage(keyId: string, outcome: "call" | "refused", now = new Date()): Promise<void> {
  try {
    const increment = outcome === "call" ? { calls: { increment: 1 } } : { refused: { increment: 1 } };
    await prisma.apiUsageDay.upsert({
      where: { keyId_day: { keyId, day: utcDay(now) } },
      create: { keyId, day: utcDay(now), calls: outcome === "call" ? 1 : 0, refused: outcome === "refused" ? 1 : 0 },
      update: increment,
    });
    if (outcome === "call") await prisma.apiKey.updateMany({ where: { id: keyId }, data: { lastUsedAt: now } });
  } catch {
    console.warn("[api] journal d’usage indisponible");
  }
}
