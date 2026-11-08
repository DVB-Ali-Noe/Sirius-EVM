import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { attestedRunnerFetch } from "../../src/lib/tee/ra-tls-client";
import { phalaCvm, type CvmPower, type PhalaCvmIO } from "./phala-cvm";

/**
 * Contrôleur de disponibilité de la CVM pour l'API développeurs (D-30), sur le VPS.
 * La CVM reste allumée tant qu'un prêt, une prolongation ou un pack est en cours (lock non échu ou
 * `release` diffusé), ou qu'une
 * location active porte au moins une clé API non révoquée ; elle est arrêtée après une période
 * sans aucun de ces cas. Aucun appel anonyme ne peut la démarrer : seul l'état en base compte.
 */

export type AvailabilityPhase = "stopped" | "starting" | "running" | "stopping";
/** `unknown` : l'état fournisseur n'a pas pu être lu à ce tour. */
export type ObservedCvm = CvmPower | "unknown";

export interface AvailabilityLoanRecord {
  id: string;
  status: string;
  rentalExpiresAt: Date | null;
  /** Échéance du lock on-chain ; au-delà, sans `release` diffusé, seul `refund()` reste possible. */
  evmDeadline: Date | null;
  settleTxHash: string | null;
}
export interface AvailabilityApiKey { loanId: string; revokedAt: Date | null }
/** Lecture en base d'un tour : prêts pertinents, clés actives, réveil demandé par un wallet authentifié. */
export interface AvailabilityRecords {
  loans: AvailabilityLoanRecord[];
  apiKeys: AvailabilityApiKey[];
  /** `RunnerAvailability.requestedUntil` : action wallet authentifiée (emprunteur, fournisseur qui publie), voir D-30. */
  requestedUntil: Date | null;
}

export interface AvailabilityMemory {
  phase: AvailabilityPhase;
  /** Début de la phase courante (ms). */
  since: number;
  /** Dernier tour où un besoin a été constaté (ms) ; initialisé au démarrage du contrôleur. */
  lastNeededAt: number;
  /** Premier tour où le runner était injoignable alors qu'il était nécessaire. */
  unreachableSince: number | null;
  lastAlertAt: number | null;
  lastCommand: { action: "start" | "stop"; at: number } | null;
}

export interface AvailabilityState extends AvailabilityRecords {
  memory: AvailabilityMemory;
  cvm: ObservedCvm;
  /** `/health` du runner a répondu `ok` via RA-TLS à ce tour. */
  healthy: boolean;
}

export interface AvailabilityOptions { idleMs: number; alertMs: number; commandRetryMs: number }
export interface AvailabilityDecision {
  memory: AvailabilityMemory;
  needed: boolean;
  action: "start" | "stop" | null;
  alert: string | null;
}

export const IN_FLIGHT_LOAN_STATUSES = ["ESCROWED", "TRAINING", "SETTLING"] as const;
export const DEFAULT_AVAILABILITY_OPTIONS: AvailabilityOptions = {
  idleMs: 30 * 60_000,
  alertMs: 10 * 60_000,
  commandRetryMs: 5 * 60_000,
};

/**
 * Prêt en cours qui justifie la CVM : ESCROWED/TRAINING/SETTLING avec un `release` déjà diffusé
 * (`settleTxHash`, le runner doit le finir) ou un lock dont l'échéance `evmDeadline` est future.
 * Un lock échu sans `release` est abandonné : le contrat refuse tout `release`, seul `refund()` par
 * l'emprunteur libère les fonds, sans le runner. Sans `evmDeadline` (lock pas encore lu), le prêt
 * compte encore : aucun champ ne permet de le dire abandonné.
 */
export function inFlightLoanNeeded(loan: AvailabilityLoanRecord, now: number): boolean {
  if (!(IN_FLIGHT_LOAN_STATUSES as readonly string[]).includes(loan.status)) return false;
  return loan.settleTxHash !== null || loan.evmDeadline === null || loan.evmDeadline.getTime() > now;
}

/**
 * Besoin de la CVM : un prêt en cours (prolongations et packs compris, ce sont des prêts) au sens
 * d'`inFlightLoanNeeded`, un prêt SETTLED non expiré portant une clé non révoquée, ou un réveil
 * demandé par une action wallet authentifiée (`requestedUntil` dans le futur).
 */
export function availabilityNeeded({ loans, apiKeys, requestedUntil }: AvailabilityRecords, now: number): boolean {
  if (requestedUntil !== null && requestedUntil.getTime() > now) return true;
  if (loans.some((loan) => inFlightLoanNeeded(loan, now))) return true;
  const keyed = new Set(apiKeys.filter((key) => key.revokedAt === null).map((key) => key.loanId));
  return loans.some((loan) => loan.status === "SETTLED" && loan.rentalExpiresAt !== null
    && loan.rentalExpiresAt.getTime() > now && keyed.has(loan.id));
}

/** Décision pure d'un tour : nouvelle mémoire, commande éventuelle et alerte. */
export function availabilityDecision(
  state: AvailabilityState,
  now: number,
  options: AvailabilityOptions = DEFAULT_AVAILABILITY_OPTIONS,
): AvailabilityDecision {
  const previous = state.memory;
  const needed = availabilityNeeded(state, now);
  const lastNeededAt = needed ? now : previous.lastNeededAt;
  const idle = !needed && now - lastNeededAt >= options.idleMs;
  const recent = (action: "start" | "stop") => previous.lastCommand?.action === action
    && now - previous.lastCommand.at < options.commandRetryMs;
  let phase: AvailabilityPhase = previous.phase;
  let action: "start" | "stop" | null = null;

  if (state.cvm === "unknown") {
    // État fournisseur illisible : aucune commande, la phase publiée reste celle du tour précédent,
    // sauf « running » qui n'est plus prouvé sans réponse du runner.
    if (phase === "running" && !state.healthy) phase = "starting";
  } else if (needed) {
    if (state.cvm === "running") phase = state.healthy ? "running" : "starting";
    else {
      phase = "starting";
      if (state.cvm === "stopped" && !recent("start")) action = "start";
    }
  } else if (idle) {
    if (state.cvm === "stopped") phase = "stopped";
    else {
      phase = "stopping";
      if (state.cvm === "running" && !recent("stop")) action = "stop";
    }
  } else if (state.cvm === "stopped") phase = "stopped";
  else if (state.cvm === "running") phase = state.healthy ? "running" : "starting";
  else if (phase === "running" || phase === "stopped") phase = "starting";

  const unreachable = needed && !state.healthy;
  const unreachableSince = unreachable ? previous.unreachableSince ?? now : null;
  let lastAlertAt = unreachable ? previous.lastAlertAt : null;
  let alert: string | null = null;
  if (unreachableSince !== null && now - unreachableSince > options.alertMs
    && (lastAlertAt === null || now - lastAlertAt >= options.alertMs)) {
    lastAlertAt = now;
    alert = `ALERTE runner API injoignable depuis ${Math.floor((now - unreachableSince) / 60_000)} min alors qu'il est nécessaire (CVM ${state.cvm})`;
  }

  return {
    needed,
    action,
    alert,
    memory: {
      phase,
      since: phase === previous.phase ? previous.since : now,
      lastNeededAt,
      unreachableSince,
      lastAlertAt,
      lastCommand: action ? { action, at: now } : previous.lastCommand,
    },
  };
}

export interface AvailabilityConfig { idleMs: number; pollMs: number }

/** Refus de toute exécution hors activation explicite, et toujours sur l'instance démo. */
export function availabilityConfig(env: Readonly<Record<string, string | undefined>>): AvailabilityConfig {
  if (env.SIRIUS_PHALA_DEMO === "true") throw new Error("Contrôleur API refusé sur l'instance de démonstration Phala");
  if (env.SIRIUS_API_AVAILABILITY !== "true") throw new Error("Contrôleur API désactivé : SIRIUS_API_AVAILABILITY=true requis");
  if (env.PHALA_DEMO_CVM_ID && env.PHALA_DEMO_CVM_ID === env.SIRIUS_API_PHALA_CVM_ID) {
    throw new Error("Contrôleur API refusé : la CVM déclarée est celle de la démonstration");
  }
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} invalide (${min}–${max})`);
    return value;
  };
  return {
    idleMs: integer("SIRIUS_API_AVAILABILITY_IDLE_MINUTES", 30, 5, 1440) * 60_000,
    pollMs: integer("SIRIUS_API_AVAILABILITY_POLL_SECONDS", 60, 10, 600) * 1000,
  };
}

export interface AvailabilityIO extends PhalaCvmIO {
  records(now: Date): Promise<AvailabilityRecords>;
  health(): Promise<boolean>;
  publish(phase: AvailabilityPhase, since: Date): Promise<void>;
  log(line: string): void;
  alert(line: string): void;
}

/** Un tour complet : observation, décision, commande, publication. Ne lève jamais. */
export async function availabilityTick(
  memory: AvailabilityMemory,
  io: AvailabilityIO,
  now: number,
  options: AvailabilityOptions = DEFAULT_AVAILABILITY_OPTIONS,
): Promise<AvailabilityMemory> {
  let records: AvailabilityRecords;
  try { records = await io.records(new Date(now)); } catch {
    io.log("Base indisponible : aucun changement de la CVM à ce tour");
    return memory;
  }
  let cvm: ObservedCvm = "unknown";
  try { cvm = await io.getCvm(); } catch { io.log("État Phala illisible à ce tour"); }
  let healthy = false;
  if (cvm === "running") { try { healthy = await io.health(); } catch { healthy = false; } }
  const decision = availabilityDecision({ memory, ...records, cvm, healthy }, now, options);
  let next = decision.memory;
  if (decision.alert) io.alert(decision.alert);
  if (decision.action) {
    io.log(`${decision.action === "start" ? "Démarrage" : "Arrêt"} de la CVM demandé (besoin : ${decision.needed ? "oui" : "non"})`);
    try { await (decision.action === "start" ? io.startCvm() : io.stopCvm()); } catch {
      io.log(`Commande Phala ${decision.action} refusée : nouvel essai au prochain tour`);
      next = { ...next, lastCommand: null };
    }
  }
  if (next.phase !== memory.phase) io.log(`Phase ${memory.phase} → ${next.phase}`);
  try { await io.publish(next.phase, new Date(next.since)); } catch { io.log("Publication de RunnerAvailability échouée"); }
  return next;
}

async function main() {
  const config = availabilityConfig(process.env);
  const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} requis`); return value; };
  const phala = phalaCvm({
    profile: required("SIRIUS_API_PHALA_PROFILE"),
    cvm: required("SIRIUS_API_PHALA_CVM_ID"),
    appId: required("SIRIUS_API_PHALA_APP_ID"),
  });
  const runner = new URL(required("RUNNER_URL"));
  if (runner.protocol !== "https:" || runner.origin !== runner.href.slice(0, -1)) throw new Error("Origine HTTPS du runner requise");
  // Import différé : src/lib/db exige DATABASE_URL dès son chargement, et les tests importent ce module sans base.
  const { prisma } = await import("../../src/lib/db");
  const io: AvailabilityIO = {
    ...phala,
    records: async (now) => {
      const loanFields = { id: true, status: true, rentalExpiresAt: true, evmDeadline: true, settleTxHash: true } as const;
      const [inFlight, apiKeys, availability] = await Promise.all([
        // Même règle qu'`inFlightLoanNeeded`, appliquée en base.
        prisma.loan.findMany({
          where: {
            status: { in: [...IN_FLIGHT_LOAN_STATUSES] },
            OR: [{ settleTxHash: { not: null } }, { evmDeadline: null }, { evmDeadline: { gt: now } }],
          },
          select: loanFields, take: 1,
        }),
        prisma.apiKey.findMany({ where: { revokedAt: null }, select: { loanId: true, revokedAt: true }, distinct: ["loanId"] }),
        prisma.runnerAvailability.findUnique({ where: { id: 1 }, select: { requestedUntil: true } }),
      ]);
      const rented = apiKeys.length === 0 ? [] : await prisma.loan.findMany({
        where: { id: { in: apiKeys.map((key) => key.loanId) }, status: "SETTLED", rentalExpiresAt: { gt: now } },
        select: loanFields, take: 1,
      });
      return { loans: [...inFlight, ...rented], apiKeys, requestedUntil: availability?.requestedUntil ?? null };
    },
    health: async () => {
      const response = await attestedRunnerFetch(new URL("/health", runner), { method: "GET", timeoutMs: 15_000 });
      if (!response.ok) return false;
      const body = await response.json() as { status?: unknown };
      return body.status === "ok";
    },
    publish: async (phase, since) => {
      await prisma.runnerAvailability.upsert({ where: { id: 1 }, create: { id: 1, phase, since }, update: { phase, since } });
    },
    log: (line) => console.log(`[api-availability] ${new Date().toISOString()} ${line}`),
    alert: (line) => console.error(`[api-availability] ${new Date().toISOString()} ${line}`),
  };
  const stored = await prisma.runnerAvailability.findUnique({ where: { id: 1 } }).catch(() => null);
  const started = Date.now();
  const storedPhase = stored && ["stopped", "starting", "running", "stopping"].includes(stored.phase) ? stored.phase as AvailabilityPhase : null;
  // Après un redémarrage du contrôleur, le délai d'inactivité repart de zéro : jamais d'arrêt immédiat.
  let memory: AvailabilityMemory = {
    phase: storedPhase ?? "stopped",
    since: stored && storedPhase ? stored.since.getTime() : started,
    lastNeededAt: started, unreachableSince: null, lastAlertAt: null, lastCommand: null,
  };
  const options = { ...DEFAULT_AVAILABILITY_OPTIONS, idleMs: config.idleMs };
  const abort = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => abort.abort());
  io.log(`Contrôleur actif (inactivité ${config.idleMs / 60_000} min, tour ${config.pollMs / 1000} s)`);
  while (!abort.signal.aborted) {
    memory = await availabilityTick(memory, io, Date.now(), options);
    await delay(config.pollMs, undefined, { signal: abort.signal }).catch(() => undefined);
  }
  await prisma.$disconnect();
  io.log("Contrôleur arrêté ; la CVM est laissée dans son état actuel");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Contrôleur API arrêté : ${error instanceof Error ? error.message : "configuration privée à vérifier"}`);
    process.exitCode = 1;
  });
}
