import "server-only";
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { AppError } from "@/lib/app-error";
import { canonicalSubject } from "@/lib/subject";
import { MODEL_REF_ID_PATTERN, modelRefString, type ApiRemaining, type ModelRef } from "@/lib/tee/contract";
import { predictionSessionRevision } from "@/lib/phala-demo/runner-session";
import { DAY_MS } from "@/lib/billing/rental";
import { API_ACCESS_STALE, API_ACCESS_STALE_CODE } from "@/lib/billing/api-pricing";

type SqlValue = string | number;
interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: SqlValue[]): Record<string, unknown> | undefined;
    run(...values: SqlValue[]): { changes: number | bigint };
  };
  close(): void;
}

/** Quota quotidien d'un prêt tiré de la politique (`apiCallsPerDay`, D-30) : 1 à 10 000. */
const MAX_DAILY_LIMIT = 10_000;
const USAGE_SCHEMA_VERSION = 3;

function environmentDailyLimit(): number {
  const raw = process.env.RUNNER_PREDICT_DAILY_LIMIT ?? "24";
  const limit = Number(raw);
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(raw) || !Number.isSafeInteger(limit)) {
    throw new AppError("Quota quotidien de prédiction invalide", 503);
  }
  return limit;
}

/** Quota explicite (prêt dont le profil a un `apiCallsPerDay`) ou, à défaut, `RUNNER_PREDICT_DAILY_LIMIT`. */
function dailyLimit(explicit?: number): number {
  if (explicit === undefined) return environmentDailyLimit();
  if (!Number.isSafeInteger(explicit) || explicit < 1 || explicit > MAX_DAILY_LIMIT) {
    throw new AppError("Quota quotidien de prédiction invalide", 503);
  }
  return explicit;
}

function usageDatabase(): Database {
  const path = process.env.RUNNER_PREDICT_USAGE_FILE;
  if (!path || !isAbsolute(path)) throw new AppError("Registre de prédiction indisponible", 503);
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) {
    throw new AppError("Répertoire de prédiction privé requis", 503);
  }
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || stat.uid !== process.getuid?.()) {
      throw new AppError("Registre de prédiction privé requis", 503);
    }
  } finally {
    closeSync(fd);
  }
  const sqlite = process.getBuiltinModule("node:sqlite") as unknown as { DatabaseSync: new (path: string) => Database };
  const db = new sqlite.DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = 3000;
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      -- v2 : clé modelRefString (job:… / loan:…) ; les tables v1 du prototype restent intactes.
      CREATE TABLE IF NOT EXISTS prediction_usage_v2 (
        day TEXT NOT NULL, subject TEXT NOT NULL, model_ref TEXT NOT NULL,
        count INTEGER NOT NULL CHECK(count >= 1 AND count <= 100),
        session_revision INTEGER NOT NULL,
        PRIMARY KEY(day, subject, model_ref)
      );
      -- v3 (D-30) : quota d'un prêt jusqu'à 10 000 appels par jour ; v2 recopiée une fois.
      CREATE TABLE IF NOT EXISTS prediction_usage_v3 (
        day TEXT NOT NULL, subject TEXT NOT NULL, model_ref TEXT NOT NULL,
        count INTEGER NOT NULL CHECK(count >= 1 AND count <= 10000),
        session_revision INTEGER NOT NULL,
        PRIMARY KEY(day, subject, model_ref)
      );
      CREATE TABLE IF NOT EXISTS prediction_counters_v2 (
        subject TEXT NOT NULL, model_ref TEXT NOT NULL,
        total INTEGER NOT NULL CHECK(total >= 1),
        PRIMARY KEY(subject, model_ref)
      );
      -- Crédits de packs d'appels par prêt d'origine (emprunteur, loan:…), consommés après le quota du jour.
      CREATE TABLE IF NOT EXISTS prediction_credits_v1 (
        subject TEXT NOT NULL, model_ref TEXT NOT NULL,
        credits INTEGER NOT NULL CHECK(credits >= 0),
        PRIMARY KEY(subject, model_ref)
      );
      -- Journal des packs crédités, clé = loanId du prêt de pack : un pack ne crédite qu'une fois.
      CREATE TABLE IF NOT EXISTS prediction_packs_v1 (
        pack_loan_id TEXT PRIMARY KEY, subject TEXT NOT NULL, model_ref TEXT NOT NULL,
        calls INTEGER NOT NULL CHECK(calls >= 1), credited_at INTEGER NOT NULL
      );
      -- Passes d'accès API (D-32), clé = loanId du prêt de pass : couverture fixée une fois, jamais retirée.
      CREATE TABLE IF NOT EXISTS api_access_passes_v1 (
        pass_loan_id TEXT PRIMARY KEY, subject TEXT NOT NULL, model_ref TEXT NOT NULL,
        days INTEGER NOT NULL CHECK(days >= 1), paid_until INTEGER NOT NULL, recorded_at INTEGER NOT NULL
      );
      -- Pass engagé par prêt d'origine (D-32) : posé avant la release, effacé à l'enregistrement du
      -- pass. Un second pass sur la même base est refusé tant que la release engagée vit.
      CREATE TABLE IF NOT EXISTS api_access_engaged_v1 (
        subject TEXT NOT NULL, model_ref TEXT NOT NULL, pass_loan_id TEXT NOT NULL,
        release_id TEXT NOT NULL, release_fingerprint TEXT NOT NULL, engaged_at INTEGER NOT NULL,
        PRIMARY KEY(subject, model_ref)
      );`);
    if (Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0) < USAGE_SCHEMA_VERSION) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`INSERT OR IGNORE INTO prediction_usage_v3(day, subject, model_ref, count, session_revision)
          SELECT day, subject, model_ref, count, session_revision FROM prediction_usage_v2;
          PRAGMA user_version = ${USAGE_SCHEMA_VERSION};`);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function transaction<T>(action: (db: Database) => T): T {
  const db = usageDatabase();
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function assertScope(owner: string, ref: ModelRef): void {
  if (!/^0x[0-9a-f]{40}$/.test(owner) || (ref.kind !== "job" && ref.kind !== "loan") || !MODEL_REF_ID_PATTERN.test(ref.id)) {
    throw new AppError("Scope de prédiction invalide", 400);
  }
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function usedToday(db: Database, day: string, owner: string, modelRef: string): number {
  return Number(db.prepare("SELECT count FROM prediction_usage_v3 WHERE day = ? AND subject = ? AND model_ref = ?")
    .get(day, owner, modelRef)?.count ?? 0);
}

function creditBalance(db: Database, owner: string, modelRef: string): number {
  const credits = Number(db.prepare("SELECT credits FROM prediction_credits_v1 WHERE subject = ? AND model_ref = ?")
    .get(owner, modelRef)?.credits ?? 0);
  if (!Number.isSafeInteger(credits) || credits < 0) throw new AppError("Crédits d’appels invalides", 503);
  return credits;
}

export interface PredictionReservation {
  /** Compteur total signé dans la prédiction, par `(sujet, modelRef)`. */
  counter: number;
  remaining: ApiRemaining;
}

/**
 * Décompte avant tout calcul, par `(sujet, modelRefString)` ; une erreur après la réservation ne
 * rembourse pas un essai. D'abord le quota du jour (UTC) — `limit` pour un prêt dont le profil a
 * un `apiCallsPerDay`, sinon `RUNNER_PREDICT_DAILY_LIMIT` —, puis les crédits de packs du prêt.
 * Site et API partagent ce compteur. Les deux épuisés : 429 `quota_exceeded`.
 */
export function reservePrediction(subject: string, ref: ModelRef, sessionRevision: number, limit?: number): PredictionReservation {
  const owner = canonicalSubject(subject);
  assertScope(owner, ref);
  if (!Number.isSafeInteger(sessionRevision) || sessionRevision < 0) throw new AppError("Scope de prédiction invalide", 400);
  const daily = dailyLimit(limit);
  return transaction((db) => {
    if (predictionSessionRevision() !== sessionRevision) throw new AppError("Session Phala remplacée ; renouvelle l’autorisation", 409);
    const modelRef = modelRefString(ref);
    const day = utcDay();
    const used = usedToday(db, day, owner, modelRef);
    let credits = ref.kind === "loan" ? creditBalance(db, owner, modelRef) : 0;
    let usedAfter = used;
    if (used < daily) {
      usedAfter = used + 1;
      db.prepare(`INSERT INTO prediction_usage_v3(day, subject, model_ref, count, session_revision) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(day, subject, model_ref) DO UPDATE SET count = excluded.count,
        session_revision = excluded.session_revision`).run(day, owner, modelRef, usedAfter, sessionRevision);
    } else if (credits > 0) {
      credits -= 1;
      db.prepare("UPDATE prediction_credits_v1 SET credits = ? WHERE subject = ? AND model_ref = ?").run(credits, owner, modelRef);
    } else {
      throw new AppError("Quota quotidien de prédiction atteint", 429, "quota_exceeded");
    }
    db.prepare(`INSERT INTO prediction_counters_v2(subject, model_ref, total) VALUES (?, ?, 1)
      ON CONFLICT(subject, model_ref) DO UPDATE SET total = total + 1`)
      .run(owner, modelRef);
    const total = Number(db.prepare("SELECT total FROM prediction_counters_v2 WHERE subject = ? AND model_ref = ?")
      .get(owner, modelRef)!.total);
    if (!Number.isSafeInteger(total)) throw new AppError("Compteur de prédiction invalide", 503);
    return { counter: total, remaining: { today: Math.max(0, daily - usedAfter), credits } };
  });
}

/** Appels restants sans rien consommer (`api-info`). */
export function predictionAllowance(subject: string, ref: ModelRef, limit?: number): ApiRemaining {
  const owner = canonicalSubject(subject);
  assertScope(owner, ref);
  const daily = dailyLimit(limit);
  return transaction((db) => {
    const modelRef = modelRefString(ref);
    return {
      today: Math.max(0, daily - usedToday(db, utcDay(), owner, modelRef)),
      credits: ref.kind === "loan" ? creditBalance(db, owner, modelRef) : 0,
    };
  });
}

/**
 * Crédite `calls` appels au prêt d'origine une seule fois par pack (clé : loanId du prêt de pack),
 * dans la même transaction que le journal. Rejouable : un pack déjà crédité ne change rien. Renvoie
 * le solde de crédits du prêt d'origine.
 */
export function creditCallPack(input: { packLoanId: string; originalLoanId: string; subject: string; calls: number; now?: number }): number {
  const owner = canonicalSubject(input.subject);
  const ref: ModelRef = { kind: "loan", id: input.originalLoanId };
  assertScope(owner, ref);
  if (!MODEL_REF_ID_PATTERN.test(input.packLoanId) || input.packLoanId === input.originalLoanId) {
    throw new AppError("Identifiant de pack invalide", 400);
  }
  if (!Number.isSafeInteger(input.calls) || input.calls < 1 || input.calls > MAX_DAILY_LIMIT) throw new AppError("Taille de pack invalide", 400);
  const modelRef = modelRefString(ref);
  return transaction((db) => {
    const credited = db.prepare("SELECT subject, model_ref, calls FROM prediction_packs_v1 WHERE pack_loan_id = ?").get(input.packLoanId);
    if (credited) {
      if (credited.subject !== owner || credited.model_ref !== modelRef || Number(credited.calls) !== input.calls) {
        throw new AppError("Pack d’appels hors scope", 409);
      }
      return creditBalance(db, owner, modelRef);
    }
    db.prepare("INSERT INTO prediction_packs_v1(pack_loan_id, subject, model_ref, calls, credited_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.packLoanId, owner, modelRef, input.calls, input.now ?? Date.now());
    db.prepare(`INSERT INTO prediction_credits_v1(subject, model_ref, credits) VALUES (?, ?, ?)
      ON CONFLICT(subject, model_ref) DO UPDATE SET credits = credits + excluded.credits`).run(owner, modelRef, input.calls);
    return creditBalance(db, owner, modelRef);
  });
}

/**
 * Solde de packs d'un prêt remis à zéro, quel qu'en soit le sujet, à la suppression de son modèle
 * (`sweepExpiredLoanModels`, D-30) : les crédits survivent à une prolongation pendant le délai de
 * grâce et sont perdus avec le modèle. Le journal des packs reste : un `buy-calls` rejoué ensuite
 * ne recrédite rien.
 */
export function clearLoanCredits(loanId: string): void {
  const ref: ModelRef = { kind: "loan", id: loanId };
  if (!MODEL_REF_ID_PATTERN.test(loanId)) throw new AppError("Scope de prédiction invalide", 400);
  const modelRef = modelRefString(ref);
  transaction((db) => { db.prepare("DELETE FROM prediction_credits_v1 WHERE model_ref = ?").run(modelRef); });
}

function coverageEnd(db: Database, owner: string, modelRef: string): number | null {
  const value = db.prepare("SELECT MAX(paid_until) AS paid_until FROM api_access_passes_v1 WHERE subject = ? AND model_ref = ?")
    .get(owner, modelRef)?.paid_until;
  if (value === null || value === undefined) return null;
  const paidUntil = Number(value);
  if (!Number.isSafeInteger(paidUntil)) throw new AppError("Couverture d’accès API invalide", 503);
  return paidUntil;
}

/** Fin (ms) de la couverture d'accès API payée du prêt `loanId` pour `subject`, `null` sans pass (D-32). */
export function apiAccessPaidUntil(subject: string, loanId: string): number | null {
  const owner = canonicalSubject(subject);
  const ref: ModelRef = { kind: "loan", id: loanId };
  assertScope(owner, ref);
  return transaction((db) => coverageEnd(db, owner, modelRefString(ref)));
}

/** Release de pass engagée : opération du journal des transactions de l'enclave. */
export interface ApiAccessRelease { id: string; fingerprint: string }

/**
 * Engage un pass d'accès API avant sa release (D-32), dans une seule transaction : la couverture
 * doit encore valoir celle de son devis (`coveredUntil`), et aucun autre pass du même prêt ne doit
 * être engagé avec une release encore vivante (`isLive` : en cours dans ce processus, ou signée dans
 * le journal des transactions sans échec définitif). Sinon refus `api_access_stale`, avant toute
 * transaction. Idempotent pour le même pass ; un marqueur d'un pass dont la release n'a jamais été
 * engagée ou a définitivement échoué est repris. Persistant : survit au redémarrage du runner.
 */
export function engageApiAccessPass(input: {
  passLoanId: string; originalLoanId: string; subject: string; coveredUntil: number | null; release: ApiAccessRelease;
  isLive: (passLoanId: string, release: ApiAccessRelease) => boolean; now?: number;
}): void {
  const owner = canonicalSubject(input.subject);
  const ref: ModelRef = { kind: "loan", id: input.originalLoanId };
  assertScope(owner, ref);
  if (!MODEL_REF_ID_PATTERN.test(input.passLoanId) || input.passLoanId === input.originalLoanId) {
    throw new AppError("Identifiant de pass invalide", 400);
  }
  const modelRef = modelRefString(ref);
  transaction((db) => {
    if (coverageEnd(db, owner, modelRef) !== input.coveredUntil) throw new AppError(API_ACCESS_STALE, 409, API_ACCESS_STALE_CODE);
    const engaged = db.prepare("SELECT pass_loan_id, release_id, release_fingerprint FROM api_access_engaged_v1 WHERE subject = ? AND model_ref = ?")
      .get(owner, modelRef);
    if (engaged && engaged.pass_loan_id !== input.passLoanId
      && input.isLive(String(engaged.pass_loan_id), { id: String(engaged.release_id), fingerprint: String(engaged.release_fingerprint) })) {
      throw new AppError(API_ACCESS_STALE, 409, API_ACCESS_STALE_CODE);
    }
    db.prepare(`INSERT INTO api_access_engaged_v1(subject, model_ref, pass_loan_id, release_id, release_fingerprint, engaged_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(subject, model_ref) DO UPDATE SET pass_loan_id = excluded.pass_loan_id,
      release_id = excluded.release_id, release_fingerprint = excluded.release_fingerprint, engaged_at = excluded.engaged_at`)
      .run(owner, modelRef, input.passLoanId, input.release.id, input.release.fingerprint, input.now ?? Date.now());
  });
}

/** Couverture déjà enregistrée pour ce prêt payant (pass, emprunt ou prolongation à API incluse). */
export function hasApiAccessPass(passLoanId: string): boolean {
  if (!MODEL_REF_ID_PATTERN.test(passLoanId)) throw new AppError("Identifiant de pass invalide", 400);
  return transaction((db) => Boolean(db.prepare("SELECT 1 AS hit FROM api_access_passes_v1 WHERE pass_loan_id = ?").get(passLoanId)));
}

/**
 * Enregistre une couverture d'accès API réglée (D-32), une seule fois par prêt payant (clé
 * `passLoanId`) : pass, ou emprunt et prolongation à API incluse (clé : ce prêt, éventuellement le
 * prêt d'origine lui-même), dans la même transaction que la lecture de la couverture :
 * `paid_until = min(échéance de la location, max(release, couverture précédente) + days jours)`.
 * Rejouable : une couverture déjà enregistrée ne change rien, même après une prolongation ou un
 * changement de tarif. Le marqueur d'engagement de ce pass est effacé dans la même transaction.
 * Renvoie la fin de couverture du prêt.
 */
export function recordApiAccessPass(input: {
  passLoanId: string; originalLoanId: string; subject: string; days: number; releasedAt: number; rentalExpiresAt: number; now?: number;
}): number {
  const owner = canonicalSubject(input.subject);
  const ref: ModelRef = { kind: "loan", id: input.originalLoanId };
  assertScope(owner, ref);
  if (!MODEL_REF_ID_PATTERN.test(input.passLoanId)) throw new AppError("Identifiant de pass invalide", 400);
  if (!Number.isSafeInteger(input.days) || input.days < 1 || !Number.isSafeInteger(input.releasedAt)
    || !Number.isSafeInteger(input.rentalExpiresAt)) throw new AppError("Pass d’accès API invalide", 400);
  const modelRef = modelRefString(ref);
  return transaction((db) => {
    const recorded = db.prepare("SELECT subject, model_ref, days FROM api_access_passes_v1 WHERE pass_loan_id = ?").get(input.passLoanId);
    if (recorded) {
      if (recorded.subject !== owner || recorded.model_ref !== modelRef || Number(recorded.days) !== input.days) {
        throw new AppError("Pass d’accès API hors scope", 409);
      }
      db.prepare("DELETE FROM api_access_engaged_v1 WHERE pass_loan_id = ?").run(input.passLoanId);
      return coverageEnd(db, owner, modelRef)!;
    }
    const start = Math.max(input.releasedAt, coverageEnd(db, owner, modelRef) ?? 0);
    const paidUntil = Math.min(input.rentalExpiresAt, start + input.days * DAY_MS);
    db.prepare("INSERT INTO api_access_passes_v1(pass_loan_id, subject, model_ref, days, paid_until, recorded_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.passLoanId, owner, modelRef, input.days, paidUntil, input.now ?? Date.now());
    db.prepare("DELETE FROM api_access_engaged_v1 WHERE pass_loan_id = ?").run(input.passLoanId);
    return coverageEnd(db, owner, modelRef)!;
  });
}
