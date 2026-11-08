import "server-only";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";

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
/** CVM allumée : `requestedUntil` n'est réécrit que s'il lui reste moins que `RUNNER_WAKE_MS` moins ce délai. */
export const ACTIVITY_REFRESH_MS = 5 * 60_000;

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

/** Routes wallet (prêts, publication) : 503 `enclave_starting` (même corps que l'API publique), sinon réponse d'erreur habituelle. */
export function loanRouteErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof EnclaveStarting)) return errorResponse(error);
  const { body, headers } = enclaveStartingBody(error);
  return NextResponse.json(body, { status: 503, headers });
}

/**
 * Requête dont les contrôles d'accès et de validité sont déjà faits, avant toute écriture. CVM
 * allumée : l'activité la garde voulue `RUNNER_WAKE_MS` de plus, avec au plus une écriture par
 * `ACTIVITY_REFRESH_MS`. CVM pas encore allumée : réveil demandé pour `RUNNER_WAKE_MS` (jamais
 * raccourci) et refus en 503. Rejouable : rien d'autre n'est écrit. Sans ligne : aucun contrôleur,
 * rien à écrire.
 */
export async function requireRunnerOrWake(now = new Date()): Promise<void> {
  const row = await prisma.runnerAvailability.findUnique({ where: { id: 1 }, select: { phase: true, requestedUntil: true } });
  if (!row) return;
  const phase = phaseOf(row);
  const until = new Date(now.getTime() + RUNNER_WAKE_MS);
  // Allumée : seulement si le réveil en cours expire dans moins de `RUNNER_WAKE_MS - ACTIVITY_REFRESH_MS`.
  const staleBefore = phase === "running" ? new Date(until.getTime() - ACTIVITY_REFRESH_MS) : until;
  if (row.requestedUntil === null || row.requestedUntil < staleBefore) {
    await prisma.runnerAvailability.updateMany({
      where: { id: 1, OR: [{ requestedUntil: null }, { requestedUntil: { lt: staleBefore } }] },
      data: { requestedUntil: until },
    });
  }
  if (phase !== "running") throw new EnclaveStarting(phase);
}
