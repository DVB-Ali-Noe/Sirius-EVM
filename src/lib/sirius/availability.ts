import "server-only";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";

/**
 * Disponibilité de la CVM du runner pour l'API développeurs (D-30). Le contrôleur du VPS
 * (`scripts/operations/api-availability.ts`) tient la ligne `RunnerAvailability` (id = 1) : il
 * allume la CVM tant qu'un prêt est en cours, qu'une location active a une clé API, ou qu'un
 * réveil a été demandé (`requestedUntil`), et l'éteint après 30 minutes sans besoin.
 *
 * Sans ligne, aucun contrôleur ne gère la CVM sur ce déploiement (développement, staging sans
 * `SIRIUS_API_AVAILABILITY`) : le runner est réputé allumé, comme avant D-30. Les appels anonymes
 * de l'API publique ne réveillent jamais la CVM ; seules les actions wallet de l'emprunteur d'un
 * prêt loué le peuvent (`requestRunnerWake`).
 */

export type RunnerPhase = "stopped" | "starting" | "running" | "stopping";

const PHASES: readonly RunnerPhase[] = ["stopped", "starting", "running", "stopping"];

/** Réveil demandé : la CVM reste voulue au moins ce temps, puis le besoin ordinaire reprend. */
export const RUNNER_WAKE_MS = 15 * 60_000;

/** Attente annoncée (`Retry-After`) : démarrage en cours ou CVM encore à allumer. */
export const ENCLAVE_STARTING_RETRY_SECONDS = 60;
export const ENCLAVE_STOPPED_RETRY_SECONDS = 120;

export const ENCLAVE_STARTING_CODE = "enclave_starting";

export async function runnerPhase(): Promise<RunnerPhase> {
  const row = await prisma.runnerAvailability.findUnique({ where: { id: 1 }, select: { phase: true } });
  if (!row) return "running";
  // Valeur inconnue (écriture d'une autre version) : prudence, rien n'est relayé.
  return PHASES.includes(row.phase as RunnerPhase) ? (row.phase as RunnerPhase) : "stopped";
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

/** Routes wallet : 503 `enclave_starting` (même corps que l'API publique), sinon réponse d'erreur habituelle. */
export function loanRouteErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof EnclaveStarting)) return errorResponse(error);
  const { body, headers } = enclaveStartingBody(error);
  return NextResponse.json(body, { status: 503, headers });
}

/** API publique : refus sans réveil tant que la CVM n'est pas allumée. */
export async function assertRunnerRunning(): Promise<void> {
  const phase = await runnerPhase();
  if (phase !== "running") throw new EnclaveStarting(phase);
}

/**
 * Action wallet de l'emprunteur d'un prêt loué (contrôles d'accès déjà faits) : si la CVM n'est
 * pas allumée, demande son réveil pour `RUNNER_WAKE_MS` (jamais raccourci) et refuse en 503.
 */
export async function requireRunnerOrWake(now = new Date()): Promise<void> {
  const phase = await runnerPhase();
  if (phase === "running") return;
  const until = new Date(now.getTime() + RUNNER_WAKE_MS);
  await prisma.runnerAvailability.updateMany({
    where: { id: 1, OR: [{ requestedUntil: null }, { requestedUntil: { lt: until } }] },
    data: { requestedUntil: until },
  });
  throw new EnclaveStarting(phase);
}
