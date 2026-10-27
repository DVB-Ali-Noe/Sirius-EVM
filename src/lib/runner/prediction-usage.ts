import "server-only";
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { AppError } from "@/lib/app-error";
import { canonicalSubject } from "@/lib/subject";
import { assertPredictEnabled } from "@/lib/phala-demo/runner-session";

type SqlValue = string | number;
interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: SqlValue[]): Record<string, unknown> | undefined;
    run(...values: SqlValue[]): { changes: number | bigint };
  };
  close(): void;
}

function dailyLimit(): number {
  const raw = process.env.RUNNER_PREDICT_DAILY_LIMIT ?? "24";
  const limit = Number(raw);
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(raw) || !Number.isSafeInteger(limit)) {
    throw new AppError("Quota quotidien de prédiction invalide", 503);
  }
  return limit;
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
      CREATE TABLE IF NOT EXISTS prediction_usage (
        day TEXT NOT NULL, subject TEXT NOT NULL, model_id TEXT NOT NULL,
        count INTEGER NOT NULL CHECK(count >= 1 AND count <= 100),
        session_revision INTEGER NOT NULL,
        PRIMARY KEY(day, subject, model_id)
      );
      CREATE TABLE IF NOT EXISTS prediction_counters (
        subject TEXT NOT NULL, model_id TEXT NOT NULL,
        total INTEGER NOT NULL CHECK(total >= 1),
        PRIMARY KEY(subject, model_id)
      );`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Décompte avant tout calcul ; une erreur après la réservation ne rembourse pas un essai. */
export function reservePrediction(subject: string, modelId: string, sessionRevision: number): number {
  const owner = canonicalSubject(subject);
  if (!/^0x[0-9a-f]{40}$/.test(owner) || !/^[A-Za-z0-9_-]{1,128}$/.test(modelId)
    || !Number.isSafeInteger(sessionRevision) || sessionRevision < 0) throw new AppError("Scope de prédiction invalide", 400);
  const limit = dailyLimit();
  const db = usageDatabase();
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (assertPredictEnabled() !== sessionRevision) throw new AppError("Session Phala remplacée ; renouvelle l’autorisation", 409);
      const day = new Date().toISOString().slice(0, 10);
      const current = db.prepare("SELECT count FROM prediction_usage WHERE day = ? AND subject = ? AND model_id = ?")
        .get(day, owner, modelId);
      const next = Number(current?.count ?? 0) + 1;
      if (next > limit) throw new AppError("Quota quotidien de prédiction atteint", 429);
      db.prepare(`INSERT INTO prediction_usage(day, subject, model_id, count, session_revision) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(day, subject, model_id) DO UPDATE SET count = excluded.count,
        session_revision = excluded.session_revision`).run(day, owner, modelId, next, sessionRevision);
      db.prepare(`INSERT INTO prediction_counters(subject, model_id, total) VALUES (?, ?, 1)
        ON CONFLICT(subject, model_id) DO UPDATE SET total = total + 1`)
        .run(owner, modelId);
      const total = Number(db.prepare("SELECT total FROM prediction_counters WHERE subject = ? AND model_id = ?")
        .get(owner, modelId)!.total);
      if (!Number.isSafeInteger(total)) throw new AppError("Compteur de prédiction invalide", 503);
      db.exec("COMMIT");
      return total;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
