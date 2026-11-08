import "server-only";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { FixedWindowRateLimiter } from "@/lib/http/rate-limit";

/**
 * Disponibilité de la CVM du runner (D-30). Le contrôleur du VPS
 * (`scripts/operations/api-availability.ts`) tient la ligne `RunnerAvailability` (id = 1) : il
 * allume la CVM tant qu'un prêt est en cours ou qu'un réveil est encore valable (`requestedUntil`),
 * et l'éteint après 45 minutes sans besoin. Chaque action servie par le runner repousse
 * `requestedUntil` de 15 minutes : la CVM s'arrête environ une heure après la dernière activité
 * (option 1 du 8 novembre 2026 ; une clé API seule ne la garde plus allumée).
 *
 * Sans ligne, aucun contrôleur ne gère la CVM sur ce déploiement (développement, staging sans
 * `SIRIUS_API_AVAILABILITY`) : le runner est réputé allumé, comme avant D-30, et rien n'est écrit.
 * Seules des requêtes qui ont passé leurs contrôles d'accès et de validité réveillent la CVM
 * (`requireRunnerOrWake`) : emprunteur d'un prêt loué (clé API, prédiction, pack d'appels),
 * fournisseur qui publie (brouillon, scellement, envoi en morceaux), emprunteur qui demande un devis
 * (emprunt, prolongation, pack), et appel de l'API publique portant une clé existante, non révoquée,
 * d'une location en cours (signature vérifiée ensuite par l'enclave seule, voir `public-api.ts`).
 */

export type RunnerPhase = "stopped" | "starting" | "running" | "stopping";

const PHASES: readonly RunnerPhase[] = ["stopped", "starting", "running", "stopping"];

/** Réveil demandé : la CVM reste voulue au moins ce temps, puis le besoin ordinaire reprend. */
export const RUNNER_WAKE_MS = 15 * 60_000;
/**
 * `requestedUntil` n'est réécrit que s'il lui reste moins que `RUNNER_WAKE_MS` moins ce délai, quelle
 * que soit la phase : les relances d'une même attente (toutes les 30 à 45 s) n'écrivent qu'une fois.
 */
export const ACTIVITY_REFRESH_MS = 5 * 60_000;

/**
 * Budget de réveil par compte, sur la publication et le devis (`wakeSubject`) : chaque écriture de
 * `requestedUntil` coûte une unité. Une écriture garde la CVM voulue au plus ~1 h (15 min de réveil
 * + 45 min d'inactivité du contrôleur) : 12 par jour bornent un compte KYB à ~12 h de CVM par jour.
 * L'API publique n'est pas concernée (bornée par sa location).
 */
export const WAKE_WRITES_PER_HOUR = 6;
export const WAKE_WRITES_PER_DAY = 12;
/** Attente annoncée quand le budget est épuisé et que la CVM n'est pas allumée. */
export const WAKE_LIMITED_RETRY_SECONDS = 600;
const wakeHourly = new FixedWindowRateLimiter({ windowMs: 3_600_000, maxPerKey: WAKE_WRITES_PER_HOUR, maxGlobal: Number.MAX_SAFE_INTEGER, maxTrackedKeys: 10_000 });
const wakeDaily = new FixedWindowRateLimiter({ windowMs: 86_400_000, maxPerKey: WAKE_WRITES_PER_DAY, maxGlobal: Number.MAX_SAFE_INTEGER, maxTrackedKeys: 10_000 });

/** Budget de réveil épuisé alors que la CVM n'est pas allumée : 429, rien n'est écrit. */
export class WakeRateLimited extends AppError {
  readonly retryAfterSeconds = WAKE_LIMITED_RETRY_SECONDS;
  constructor() {
    super("Trop de démarrages de l’enclave demandés par ce compte — réessaie plus tard", 429);
  }
}

/**
 * Attente annoncée (`Retry-After`) : démarrage en cours ou CVM encore à allumer. Mesuré le 8 novembre
 * 2026 : CVM attestée ~50 s après la commande du contrôleur ; un délai court évite d'attendre au-delà.
 */
export const ENCLAVE_STARTING_RETRY_SECONDS = 30;
export const ENCLAVE_STOPPED_RETRY_SECONDS = 45;

export const ENCLAVE_STARTING_CODE = "enclave_starting";

function phaseOf(row: { phase: string } | null): RunnerPhase {
  if (!row) return "running";
  // Valeur inconnue (écriture d'une autre version) : prudence, rien n'est relayé.
  return PHASES.includes(row.phase as RunnerPhase) ? (row.phase as RunnerPhase) : "stopped";
}

export async function runnerPhase(): Promise<RunnerPhase> {
  return phaseOf(await prisma.runnerAvailability.findUnique({ where: { id: 1 }, select: { phase: true } }));
}

/** Réponse 503 d'une enclave pas encore prête : `starting` quand le démarrage est en cours. */
export class EnclaveStarting extends AppError {
  readonly retryAfterSeconds: number;
  readonly phase: "starting" | "stopped";

  constructor(phase: RunnerPhase) {
    const starting = phase === "starting";
    const retryAfterSeconds = starting ? ENCLAVE_STARTING_RETRY_SECONDS : ENCLAVE_STOPPED_RETRY_SECONDS;
    super(
      starting
        ? `Enclave en cours de démarrage : réessaie dans environ ${retryAfterSeconds} s`
        : `Enclave à l’arrêt, démarrage sous quelques minutes : réessaie dans environ ${retryAfterSeconds} s`,
      503,
    );
    this.retryAfterSeconds = retryAfterSeconds;
    this.phase = starting ? "starting" : "stopped";
  }
}

/** Corps et en-têtes du 503 `enclave_starting`, identiques pour l'API publique et les routes wallet. */
export function enclaveStartingBody(error: EnclaveStarting) {
  return {
    body: {
      error: { code: ENCLAVE_STARTING_CODE, message: error.message },
      code: ENCLAVE_STARTING_CODE,
      message: error.message,
      status: error.phase,
      retryAfterSeconds: error.retryAfterSeconds,
    },
    headers: { "retry-after": String(error.retryAfterSeconds), "cache-control": "no-store" },
  };
}

/**
 * Routes wallet (prêts, publication) : 503 `enclave_starting` (même corps que l'API publique), 429
 * avec `Retry-After` quand le budget de réveil est épuisé, sinon réponse d'erreur habituelle.
 */
export function loanRouteErrorResponse(error: unknown): NextResponse {
  if (error instanceof WakeRateLimited) {
    const response = errorResponse(error);
    response.headers.set("retry-after", String(error.retryAfterSeconds));
    return response;
  }
  if (!(error instanceof EnclaveStarting)) return errorResponse(error);
  const { body, headers } = enclaveStartingBody(error);
  return NextResponse.json(body, { status: 503, headers });
}

/**
 * Requête dont les contrôles d'accès et de validité sont déjà faits, avant toute écriture. Le réveil
 * est écrit (`requestedUntil` = maintenant + `RUNNER_WAKE_MS`, jamais raccourci) seulement s'il lui
 * reste moins de `RUNNER_WAKE_MS - ACTIVITY_REFRESH_MS`. CVM allumée : la requête passe toujours ;
 * CVM pas encore allumée : refus en 503 `enclave_starting`. Rejouable : rien d'autre n'est écrit.
 * Sans ligne : aucun contrôleur, rien à écrire.
 *
 * `wakeSubject` (publication, devis) : chaque écriture consomme le budget du compte. Épuisé, il
 * n'empêche jamais de servir une CVM déjà allumée (l'écriture est seulement sautée, sans
 * prolongation) ; CVM pas encore allumée, refus en 429 `WakeRateLimited`, rien d'écrit.
 */
export async function requireRunnerOrWake({ now = new Date(), wakeSubject }: { now?: Date; wakeSubject?: string } = {}): Promise<void> {
  const row = await prisma.runnerAvailability.findUnique({ where: { id: 1 }, select: { phase: true, requestedUntil: true } });
  if (!row) return;
  const phase = phaseOf(row);
  const until = new Date(now.getTime() + RUNNER_WAKE_MS);
  const staleBefore = new Date(until.getTime() - ACTIVITY_REFRESH_MS);
  if (row.requestedUntil === null || row.requestedUntil < staleBefore) {
    const key = wakeSubject ? `wake:${wakeSubject.toLowerCase()}` : null;
    // Les deux fenêtres comptent chaque écriture ; la journalière n'est pas consommée si l'horaire refuse.
    const allowed = key === null || (wakeHourly.consume(key, now.getTime()) && wakeDaily.consume(key, now.getTime()));
    if (allowed) {
      await prisma.runnerAvailability.updateMany({
        where: { id: 1, OR: [{ requestedUntil: null }, { requestedUntil: { lt: staleBefore } }] },
        data: { requestedUntil: until },
      });
    } else if (phase !== "running") {
      throw new WakeRateLimited();
    }
  }
  if (phase !== "running") throw new EnclaveStarting(phase);
}
