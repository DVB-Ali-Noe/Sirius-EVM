import "server-only";
import { prisma } from "@/lib/db";

/**
 * Budget de réveil de la CVM par compte (D-30, précision « budget de réveil »), tenu en base pour
 * valoir sur toutes les instances Next : une ligne `RunnerWakeBudget` par adresse, deux fenêtres
 * fixes (une heure, un jour). Chaque écriture de `requestedUntil` sur la publication ou le devis
 * dépense une unité des deux fenêtres ; une fenêtre échue repart de zéro à la dépense suivante.
 */
export const WAKE_WRITES_PER_HOUR = 6;
export const WAKE_WRITES_PER_DAY = 12;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** `Retry-After` annoncé au plus, même si la fenêtre journalière ne se libère que plus tard. */
export const WAKE_LIMITED_MAX_RETRY_SECONDS = 600;

export type WakeSpend = { spent: true } | { spent: false; retryAfterSeconds: number };

interface WakeBudgetWindows {
  hourStart: Date;
  hourCount: number;
  dayStart: Date;
  dayCount: number;
}

/** Délai jusqu'à ce que les deux fenêtres acceptent de nouveau une dépense, borné à 1–600 s. */
export function wakeRetryAfterSeconds(row: WakeBudgetWindows | null, now: Date): number {
  if (!row) return 1;
  const ends = [
    row.hourCount >= WAKE_WRITES_PER_HOUR ? row.hourStart.getTime() + HOUR_MS : 0,
    row.dayCount >= WAKE_WRITES_PER_DAY ? row.dayStart.getTime() + DAY_MS : 0,
  ];
  const seconds = Math.ceil((Math.max(...ends) - now.getTime()) / 1000);
  return Math.min(Math.max(seconds, 1), WAKE_LIMITED_MAX_RETRY_SECONDS);
}

/**
 * Dépense une unité du budget de `subject` (adresse en minuscules) si ses deux fenêtres, une fois
 * les fenêtres échues remises à zéro, sont sous leur plafond. Une seule instruction `INSERT … ON
 * CONFLICT DO UPDATE … WHERE` : PostgreSQL verrouille la ligne et réévalue la condition sur sa
 * version la plus récente, donc deux dépenses simultanées à plafond − 1 n'en acceptent qu'une.
 */
export async function spendWakeBudget(subject: string, now = new Date()): Promise<WakeSpend> {
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const spent = await prisma.$queryRaw<{ subject: string }[]>`
    INSERT INTO "RunnerWakeBudget" AS b ("subject", "hourStart", "hourCount", "dayStart", "dayCount")
    VALUES (${subject}, ${now}, 1, ${now}, 1)
    ON CONFLICT ("subject") DO UPDATE SET
      "hourStart" = CASE WHEN b."hourStart" <= ${hourAgo} THEN ${now} ELSE b."hourStart" END,
      "hourCount" = CASE WHEN b."hourStart" <= ${hourAgo} THEN 1 ELSE b."hourCount" + 1 END,
      "dayStart" = CASE WHEN b."dayStart" <= ${dayAgo} THEN ${now} ELSE b."dayStart" END,
      "dayCount" = CASE WHEN b."dayStart" <= ${dayAgo} THEN 1 ELSE b."dayCount" + 1 END
    WHERE (b."hourStart" <= ${hourAgo} OR b."hourCount" < ${WAKE_WRITES_PER_HOUR})
      AND (b."dayStart" <= ${dayAgo} OR b."dayCount" < ${WAKE_WRITES_PER_DAY})
    RETURNING b."subject"`;
  if (spent.length === 1) return { spent: true };
  const row = await prisma.runnerWakeBudget.findUnique({ where: { subject } });
  return { spent: false, retryAfterSeconds: wakeRetryAfterSeconds(row, now) };
}

/**
 * Lignes dont les deux fenêtres sont échues : équivalentes à une ligne absente, supprimées par le
 * reaper (aucune donnée n'est conservée au-delà d'un jour après la dernière dépense).
 */
export async function purgeExpiredWakeBudgets(now = new Date()): Promise<number> {
  const { count } = await prisma.runnerWakeBudget.deleteMany({
    where: { dayStart: { lte: new Date(now.getTime() - DAY_MS) }, hourStart: { lte: new Date(now.getTime() - HOUR_MS) } },
  });
  return count;
}
