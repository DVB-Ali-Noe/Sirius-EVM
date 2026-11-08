import "server-only";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { spendWakeBudget } from "./wake-budget";

/**
 * Disponibilité de la CVM du runner (D-30). Le contrôleur du VPS
 * (`scripts/operations/api-availability.ts`) tient la ligne `RunnerAvailability` (id = 1) : il
 * allume la CVM tant qu'un prêt en cours a encore du travail pour le runner ou qu'un réveil est
 * encore valable (`requestedUntil`), et l'éteint après 45 minutes sans besoin. Chaque action servie
 * par le runner repousse `requestedUntil` de 15 minutes : la CVM s'arrête environ une heure après
 * la dernière activité (option 1 du 8 novembre 2026 ; une clé API seule ne la garde plus allumée).
 * Le contrôleur repousse `validUntil` à chaque tour : au-delà, sa phase n'est plus crue.
 *
 * Sans ligne, aucun contrôleur ne gère la CVM sur ce déploiement (développement, staging sans
 * `SIRIUS_API_AVAILABILITY`) : le runner est réputé allumé, comme avant D-30, et rien n'est écrit.
 * Seules des requêtes qui ont passé leurs contrôles d'accès et de validité réveillent la CVM
 * (`requireRunnerOrWake`) : emprunteur d'un prêt loué (clé API, prédiction, pack d'appels),
 * emprunteur qui lance l'entraînement d'un prêt verrouillé (`/run`), fournisseur qui publie
 * (brouillon, scellement, envoi en morceaux), emprunteur qui demande un devis (emprunt,
 * prolongation, pack), et appel de l'API publique portant une clé existante, non révoquée, d'une
 * location en cours (signature vérifiée ensuite par l'enclave seule, voir `public-api.ts`).
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
 * Budget de réveil épuisé alors que la CVM est arrêtée (ou s'arrête) : 429, rien n'est écrit. Le
 * budget est tenu en base (`wake-budget.ts`), commun à toutes les instances Next.
 */
export class WakeRateLimited extends AppError {
  constructor(readonly retryAfterSeconds: number) {
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

/**
 * Phase publiée par `api-availability.ts maintenance`, service arrêté : plus rien ne gère la CVM,
 * aucune requête n'est relayée ni aucun réveil écrit jusqu'au retour du contrôleur.
 */
export const MAINTENANCE_PHASE = "maintenance";
export const CONTROLLER_UNAVAILABLE_CODE = "controller_unavailable";
export const CONTROLLER_UNAVAILABLE_RETRY_SECONDS = 60;

/**
 * Contrôleur de disponibilité en maintenance ou muet (`validUntil` dépassé : service arrêté,
 * planté ou VPS perdu) : la phase publiée n'est plus une preuve. Refus en 503 distinct, sans relayer
 * vers une CVM peut-être éteinte ni écrire de réveil que personne ne lirait.
 */
export class RunnerControllerUnavailable extends AppError {
  readonly retryAfterSeconds = CONTROLLER_UNAVAILABLE_RETRY_SECONDS;
  constructor(readonly reason: "maintenance" | "stale") {
    super(
      reason === "maintenance"
        ? "Enclave en maintenance : réessaie dans quelques minutes"
        : "Gestion de l’enclave momentanément indisponible : réessaie dans quelques minutes",
      503,
      CONTROLLER_UNAVAILABLE_CODE,
    );
  }
}

type AvailabilityRow = { phase: string; validUntil: Date | null };

/**
 * Phase utilisable, ou raison de ne pas s'y fier. `validUntil` nul : ligne d'un contrôleur antérieur
 * à ce champ, lue comme avant.
 */
function phaseOf(row: AvailabilityRow | null, now: Date): RunnerPhase | RunnerControllerUnavailable["reason"] {
  if (!row) return "running";
  if (row.phase === MAINTENANCE_PHASE) return "maintenance";
  if (row.validUntil !== null && row.validUntil.getTime() <= now.getTime()) return "stale";
  // Valeur inconnue (écriture d'une autre version) : prudence, rien n'est relayé.
  return PHASES.includes(row.phase as RunnerPhase) ? (row.phase as RunnerPhase) : "stopped";
}

let lastStaleAlertAt = 0;

/** Alerte journalisée au plus une fois par minute et par instance : le contrôleur ne publie plus. */
function alertControllerSilent(row: AvailabilityRow, now: Date): void {
  if (now.getTime() - lastStaleAlertAt < 60_000) return;
  lastStaleAlertAt = now.getTime();
  const minutes = row.validUntil ? Math.floor((now.getTime() - row.validUntil.getTime()) / 60_000) : 0;
  console.error(`[availability] ALERTE contrôleur de disponibilité muet : phase « ${row.phase} » périmée depuis ${minutes} min, requêtes runner refusées`);
}

/** Phase affichée (liste des clés API) : contrôleur muet ou en maintenance ⇒ « stopped ». */
export async function runnerPhase(now = new Date()): Promise<RunnerPhase> {
  const phase = phaseOf(await prisma.runnerAvailability.findUnique({ where: { id: 1 }, select: { phase: true, validUntil: true } }), now);
  return phase === "maintenance" || phase === "stale" ? "stopped" : phase;
}

/**
 * CVM servie à cet instant, sans rien écrire (reaper) : sans ligne, réputée allumée ; sinon phase
 * `running` publiée par un contrôleur actif.
 */
export async function runnerAwake(now = new Date()): Promise<boolean> {
  return (await runnerPhase(now)) === "running";
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
 * avec `Retry-After` quand le budget de réveil est épuisé, 503 `controller_unavailable` avec
 * `Retry-After` quand le contrôleur est muet ou en maintenance, sinon réponse d'erreur habituelle.
 */
export function loanRouteErrorResponse(error: unknown): NextResponse {
  if (error instanceof RunnerControllerUnavailable) {
    return NextResponse.json({ error: error.message, code: error.code }, {
      status: 503, headers: { "retry-after": String(error.retryAfterSeconds), "cache-control": "no-store" },
    });
  }
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
 * Sans ligne : aucun contrôleur, rien à écrire. Contrôleur en maintenance ou muet (`validUntil`
 * dépassé) : refus `RunnerControllerUnavailable` avant toute écriture, budget intact.
 *
 * `wakeSubject` (publication, devis, lancement d'un entraînement, règlement d'un pack ou d'un pass) :
 * chaque écriture dépense le budget en base du compte (`spendWakeBudget`, atomique). Épuisé, il
 * n'empêche jamais de servir une CVM déjà allumée (l'écriture est seulement sautée, sans
 * prolongation) ni d'attendre une CVM qui démarre déjà (503 habituel) ; CVM arrêtée ou qui
 * s'arrête, refus en 429 `WakeRateLimited`, rien d'écrit.
 */
export async function requireRunnerOrWake({ now = new Date(), wakeSubject }: { now?: Date; wakeSubject?: string } = {}): Promise<void> {
  const row = await prisma.runnerAvailability.findUnique({ where: { id: 1 }, select: { phase: true, requestedUntil: true, validUntil: true } });
  if (!row) return;
  const phase = phaseOf(row, now);
  if (phase === "stale") alertControllerSilent(row, now);
  if (phase === "maintenance" || phase === "stale") throw new RunnerControllerUnavailable(phase);
  const until = new Date(now.getTime() + RUNNER_WAKE_MS);
  const staleBefore = new Date(until.getTime() - ACTIVITY_REFRESH_MS);
  if (row.requestedUntil === null || row.requestedUntil < staleBefore) {
    const budget = wakeSubject ? await spendWakeBudget(wakeSubject.toLowerCase(), now) : { spent: true as const };
    if (budget.spent) {
      await prisma.runnerAvailability.updateMany({
        where: { id: 1, OR: [{ requestedUntil: null }, { requestedUntil: { lt: staleBefore } }] },
        data: { requestedUntil: until },
      });
    } else if (phase === "stopped" || phase === "stopping") {
      throw new WakeRateLimited(budget.retryAfterSeconds);
    }
  }
  if (phase !== "running") throw new EnclaveStarting(phase);
}
