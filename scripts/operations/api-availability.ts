import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { attestedRunnerFetch } from "../../src/lib/tee/ra-tls-client";
import { DAY_MS, RENTAL_GRACE_DAYS } from "../../src/lib/billing/rental";
import { assertRunnerPins } from "../../src/lib/runner/config";
import { PENDING_REAPER_TTL_MS } from "../../src/lib/sirius/reaper-policy";
import type { Prisma } from "../../src/generated/prisma/client";
import { phalaCvm, type CvmPower, type PhalaCvmIdentity, type PhalaCvmIO } from "./phala-cvm";

/**
 * Contrôleur de disponibilité de la CVM runner (D-30), sur le VPS. La CVM reste allumée tant qu'un
 * prêt, une prolongation ou un pack en cours a encore du travail pour le runner (voir
 * `inFlightLoanNeeded`), ou qu'un réveil demandé par Next est encore valable (`requestedUntil`,
 * posé et rafraîchi par chaque action qui sert le runner) ; elle est arrêtée après `idleMs` (45 min
 * par défaut) sans aucun de ces cas, soit environ une heure après la dernière activité. Une clé API
 * seule ne la garde plus allumée (option 1 du 8 novembre 2026). Seul l'état en base compte. Chaque
 * tour repousse `validUntil` : un contrôleur muet n'est plus cru par Next (audit E F4).
 */

export type AvailabilityPhase = "stopped" | "starting" | "running" | "stopping";
/** `unknown` : l'état fournisseur n'a pas pu être lu à ce tour. */
export type ObservedCvm = CvmPower | "unknown";

export interface AvailabilityLoanRecord {
  id: string;
  status: string;
  /** Échéance du lock on-chain ; au-delà, sans `release` diffusé, seul `refund()` reste possible. */
  evmDeadline: Date | null;
  settleTxHash: string | null;
  /**
   * Préparation du prêt, jamais réécrite : le lock est forcément miné avant `createdAt` +
   * `PENDING_REAPER_TTL_MS` (autorisation de lock, `lock-policy.ts`). Repère immuable de la fenêtre
   * d'un prêt verrouillé : aucune écriture ultérieure (`/run` en échec, reaper) ne la repousse.
   */
  createdAt: Date;
  extendsLoanId: string | null;
  packForLoanId: string | null;
  /** Pass refusé pour toujours par l'enclave : plus jamais rejoué, remboursable à l'échéance. */
  apiAccessRefusedAt: Date | null;
  /** Prolongation, pack ou pass : échéance de location du prêt d'origine (null : pas encore connue). */
  originRentalExpiresAt: Date | null;
}
/** Lecture en base d'un tour : prêts en cours et réveil demandé. */
export interface AvailabilityRecords {
  loans: AvailabilityLoanRecord[];
  /** `RunnerAvailability.requestedUntil` : dernière activité servie par le runner + 15 min, voir D-30. */
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

/** `validityMs` : durée pendant laquelle Next croit la phase publiée à ce tour (`validUntil`). */
export interface AvailabilityOptions { idleMs: number; alertMs: number; commandRetryMs: number; validityMs: number }
export interface AvailabilityDecision {
  memory: AvailabilityMemory;
  needed: boolean;
  action: "start" | "stop" | null;
  alert: string | null;
}

export const IN_FLIGHT_LOAN_STATUSES = ["ESCROWED", "TRAINING", "SETTLING"] as const;
/**
 * Prêt ordinaire verrouillé et pas encore lancé : la CVM reste voulue 30 min après son lock, le
 * temps de la finalité et du lancement automatique de la page. Mesuré depuis la préparation
 * (`createdAt`, immuable) plus le délai maximal du lock (`PENDING_REAPER_TTL_MS`), soit 40 min après
 * la préparation au plus : une écriture du prêt (`/run` en échec, reaper) ne repousse jamais la
 * fenêtre (revue de la PR #159). Au-delà, l'emprunteur qui revient la réveille par `/run`, au budget
 * de son compte (audit E F2).
 */
export const ESCROWED_LOAN_GRACE_MS = 30 * 60_000;
export const ESCROWED_LOAN_WINDOW_MS = PENDING_REAPER_TTL_MS + ESCROWED_LOAN_GRACE_MS;
/**
 * Durée maximale d'un tour : lecture Phala (30 s), `/health` (15 s), commande (30 s), marge. La phase
 * publiée vaut `AVAILABILITY_VALID_POLLS` intervalles plus ce délai, puis Next la tient pour inconnue.
 */
export const AVAILABILITY_TICK_MAX_MS = 90_000;
export const AVAILABILITY_VALID_POLLS = 3;
export const DEFAULT_POLL_MS = 60_000;
export const DEFAULT_AVAILABILITY_OPTIONS: AvailabilityOptions = {
  idleMs: 45 * 60_000,
  alertMs: 10 * 60_000,
  commandRetryMs: 5 * 60_000,
  validityMs: AVAILABILITY_VALID_POLLS * DEFAULT_POLL_MS + AVAILABILITY_TICK_MAX_MS,
};

/**
 * Prêt en cours (ESCROWED/TRAINING/SETTLING) qui justifie la CVM, c'est-à-dire qui a encore du
 * travail pour le runner (audit E F2) :
 * - `release` déjà diffusé (`settleTxHash`) : toujours, le runner doit le finir ;
 * - lock échu (`evmDeadline` passée) sans `release` : jamais, le contrat refuse tout `release` et
 *   seul `refund()` par l'emprunteur libère les fonds, sans le runner ;
 * - pack ou pass : tant que le reaper peut le régler, pas une fois refusé (`apiAccessRefusedAt`, ou
 *   location d'origine échue : `RENTAL_EXPIRED` avant tout `release`) ;
 * - prolongation : tant que le modèle d'origine n'est pas supprimé (`RENTAL_MODEL_DELETED`, échéance
 *   + `RENTAL_GRACE_DAYS`) ;
 * - prêt ordinaire TRAINING ou SETTLING : toujours (entraînement ou règlement en cours) ;
 * - prêt ordinaire ESCROWED : seulement `ESCROWED_LOAN_WINDOW_MS` après sa préparation (`createdAt`).
 * Sans `evmDeadline` (lock pas encore lu) ni échéance d'origine, le prêt compte : aucun champ ne
 * permet de le dire abandonné.
 */
export function inFlightLoanNeeded(loan: AvailabilityLoanRecord, now: number): boolean {
  if (!(IN_FLIGHT_LOAN_STATUSES as readonly string[]).includes(loan.status)) return false;
  if (loan.settleTxHash !== null) return true;
  if (loan.evmDeadline !== null && loan.evmDeadline.getTime() <= now) return false;
  const origin = loan.originRentalExpiresAt?.getTime() ?? null;
  if (loan.packForLoanId !== null) return loan.apiAccessRefusedAt === null && (origin === null || origin > now);
  if (loan.extendsLoanId !== null) return origin === null || origin + RENTAL_GRACE_DAYS * DAY_MS > now;
  if (loan.status !== "ESCROWED") return true;
  return loan.createdAt.getTime() > now - ESCROWED_LOAN_WINDOW_MS;
}

/** Même règle qu'`inFlightLoanNeeded`, appliquée en base (filtre Prisma de `Loan`). */
export function inFlightLoanWhere(now: Date): Prisma.LoanWhereInput {
  const unknownOrAfter = (date: Date) => ({ OR: [{ rentalExpiresAt: null }, { rentalExpiresAt: { gt: date } }] });
  return {
    status: { in: [...IN_FLIGHT_LOAN_STATUSES] },
    OR: [
      { settleTxHash: { not: null } },
      {
        AND: [
          { OR: [{ evmDeadline: null }, { evmDeadline: { gt: now } }] },
          {
            OR: [
              { packForLoanId: { not: null }, apiAccessRefusedAt: null, packForLoan: { is: unknownOrAfter(now) } },
              { extendsLoanId: { not: null }, extendsLoan: { is: unknownOrAfter(new Date(now.getTime() - RENTAL_GRACE_DAYS * DAY_MS)) } },
              { packForLoanId: null, extendsLoanId: null, status: { in: ["TRAINING", "SETTLING"] } },
              { packForLoanId: null, extendsLoanId: null, status: "ESCROWED", createdAt: { gt: new Date(now.getTime() - ESCROWED_LOAN_WINDOW_MS) } },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Besoin de la CVM : un prêt en cours (prolongations et packs compris, ce sont des prêts) au sens
 * d'`inFlightLoanNeeded`, ou un réveil encore valable (`requestedUntil` dans le futur).
 */
export function availabilityNeeded({ loans, requestedUntil }: AvailabilityRecords, now: number): boolean {
  if (requestedUntil !== null && requestedUntil.getTime() > now) return true;
  return loans.some((loan) => inFlightLoanNeeded(loan, now));
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

export interface AvailabilityConfig {
  idleMs: number;
  pollMs: number;
  /** Validité de la phase publiée : `AVAILABILITY_VALID_POLLS` tours + durée maximale d'un tour. */
  validityMs: number;
  phala: PhalaCvmIdentity;
  runnerUrl: URL;
}

const APP_ID = /^[a-f0-9]{40}$/;

/**
 * Refus de toute exécution hors activation explicite, et toujours sur la CVM de démonstration
 * (audit E F6) : `SIRIUS_PHALA_DEMO_APP_ID` déclare l'app ID de la démonstration (`none` s'il n'en
 * existe aucune sur ce compte Phala) et doit différer de `SIRIUS_API_PHALA_APP_ID`, contrôlé à chaque
 * lecture de la CVM ; `PHALA_DEMO_*`, s'ils sont présents, aussi. Pins du runner validés comme dans
 * Next (audit E F5) : un pin manquant ferait refuser chaque `/health` attesté, CVM allumée.
 */
export function availabilityConfig(env: Readonly<Record<string, string | undefined>>): AvailabilityConfig {
  if (env.SIRIUS_PHALA_DEMO === "true") throw new Error("Contrôleur API refusé sur l'instance de démonstration Phala");
  if (env.SIRIUS_API_AVAILABILITY !== "true") throw new Error("Contrôleur API désactivé : SIRIUS_API_AVAILABILITY=true requis");
  const required = (name: string) => { const value = env[name]?.trim(); if (!value) throw new Error(`${name} requis`); return value; };
  const phala = {
    profile: required("SIRIUS_API_PHALA_PROFILE"),
    cvm: required("SIRIUS_API_PHALA_CVM_ID"),
    appId: required("SIRIUS_API_PHALA_APP_ID").toLowerCase(),
  };
  if (!APP_ID.test(phala.appId)) throw new Error("SIRIUS_API_PHALA_APP_ID invalide (40 caractères hexadécimaux)");
  const demoAppId = required("SIRIUS_PHALA_DEMO_APP_ID").toLowerCase();
  if (demoAppId !== "none" && !APP_ID.test(demoAppId)) throw new Error("SIRIUS_PHALA_DEMO_APP_ID invalide : app ID de la démonstration ou none");
  if (demoAppId === phala.appId || env.PHALA_DEMO_APP_ID?.trim().toLowerCase() === phala.appId
    || (env.PHALA_DEMO_CVM_ID && env.PHALA_DEMO_CVM_ID.trim() === phala.cvm)) {
    throw new Error("Contrôleur API refusé : la CVM déclarée est celle de la démonstration");
  }
  const runnerUrl = new URL(required("RUNNER_URL"));
  if (runnerUrl.protocol !== "https:" || runnerUrl.origin !== runnerUrl.href.slice(0, -1)) throw new Error("Origine HTTPS du runner requise");
  assertRunnerPins(env);
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} invalide (${min}–${max})`);
    return value;
  };
  const pollMs = integer("SIRIUS_API_AVAILABILITY_POLL_SECONDS", DEFAULT_POLL_MS / 1000, 10, 600) * 1000;
  return {
    idleMs: integer("SIRIUS_API_AVAILABILITY_IDLE_MINUTES", 45, 5, 1440) * 60_000,
    pollMs,
    validityMs: AVAILABILITY_VALID_POLLS * pollMs + AVAILABILITY_TICK_MAX_MS,
    phala,
    runnerUrl,
  };
}

export interface AvailabilityIO extends PhalaCvmIO {
  records(now: Date): Promise<AvailabilityRecords>;
  health(): Promise<boolean>;
  /** `validUntil` : au-delà, Next tient la phase pour inconnue (contrôleur muet). */
  publish(phase: AvailabilityPhase, since: Date, validUntil: Date): Promise<void>;
  log(line: string): void;
  alert(line: string): void;
}

/**
 * Un tour complet : observation, décision, commande, publication. Ne lève jamais. Arrêt en deux
 * temps (audit E F3) : `stopping` est publié d'abord (Next ne relaie plus rien, il réveille), puis
 * les besoins sont relus ; la CVM n'est arrêtée que s'ils restent nuls, sinon elle est gardée.
 */
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
  const publish = async (phase: AvailabilityPhase, since: number) => {
    try { await io.publish(phase, new Date(since), new Date(now + options.validityMs)); return true; } catch {
      io.log("Publication de RunnerAvailability échouée");
      return false;
    }
  };
  if (decision.alert) io.alert(decision.alert);
  if (decision.action === "stop") {
    // Besoin apparu pendant la lecture Phala et le contrôle de santé : vu ici, après `stopping`.
    let recheck: "idle" | "needed" | "unreadable" = "unreadable";
    if (await publish(next.phase, next.since)) {
      try { recheck = availabilityNeeded(await io.records(new Date(now)), now) ? "needed" : "idle"; } catch { recheck = "unreadable"; }
    }
    if (recheck !== "idle") {
      io.log(recheck === "needed" ? "Besoin revenu avant l'arrêt : CVM gardée" : "Besoins illisibles avant l'arrêt : CVM gardée, nouvel essai au prochain tour");
      const phase: AvailabilityPhase = healthy ? "running" : "starting";
      next = {
        ...next, phase, since: phase === memory.phase ? memory.since : now,
        lastNeededAt: recheck === "needed" ? now : next.lastNeededAt, lastCommand: memory.lastCommand,
      };
      if (next.phase !== memory.phase) io.log(`Phase ${memory.phase} → ${next.phase}`);
      await publish(next.phase, next.since);
      return next;
    }
  }
  if (decision.action) {
    io.log(`${decision.action === "start" ? "Démarrage" : "Arrêt"} de la CVM demandé (besoin : ${decision.needed ? "oui" : "non"})`);
    try { await (decision.action === "start" ? io.startCvm() : io.stopCvm()); } catch {
      io.log(`Commande Phala ${decision.action} refusée : nouvel essai au prochain tour`);
      next = { ...next, lastCommand: null };
    }
  }
  if (next.phase !== memory.phase) io.log(`Phase ${memory.phase} → ${next.phase}`);
  await publish(next.phase, next.since);
  return next;
}

/** Phase publiée par `api-availability.ts maintenance`, lue par Next comme « contrôleur absent ». */
export const MAINTENANCE_PHASE = "maintenance";

async function main() {
  const config = availabilityConfig(process.env);
  // Import différé : src/lib/db exige DATABASE_URL dès son chargement, et les tests importent ce module sans base.
  const { prisma } = await import("../../src/lib/db");
  if (process.argv[2] === "maintenance") {
    // Service déjà arrêté (runbook) : Next refuse toute requête runner en 503 distinct, sans réveil,
    // jusqu'au premier tour du contrôleur relancé.
    const now = new Date();
    await prisma.runnerAvailability.upsert({
      where: { id: 1 },
      create: { id: 1, phase: MAINTENANCE_PHASE, since: now, validUntil: null },
      update: { phase: MAINTENANCE_PHASE, since: now, validUntil: null },
    });
    await prisma.$disconnect();
    console.log("[api-availability] Phase maintenance publiée : arrêter la CVM à la main, relancer le service pour reprendre");
    return;
  }
  const phala = phalaCvm(config.phala);
  const runner = config.runnerUrl;
  const io: AvailabilityIO = {
    ...phala,
    records: async (now) => {
      const [rows, availability] = await Promise.all([
        prisma.loan.findMany({
          where: inFlightLoanWhere(now),
          select: {
            id: true, status: true, evmDeadline: true, settleTxHash: true, createdAt: true,
            extendsLoanId: true, packForLoanId: true, apiAccessRefusedAt: true,
            packForLoan: { select: { rentalExpiresAt: true } }, extendsLoan: { select: { rentalExpiresAt: true } },
          },
          take: 1,
        }),
        prisma.runnerAvailability.findUnique({ where: { id: 1 }, select: { requestedUntil: true } }),
      ]);
      const loans = rows.map(({ packForLoan, extendsLoan, ...loan }) => ({
        ...loan, originRentalExpiresAt: (packForLoan ?? extendsLoan)?.rentalExpiresAt ?? null,
      }));
      return { loans, requestedUntil: availability?.requestedUntil ?? null };
    },
    health: async () => {
      const response = await attestedRunnerFetch(new URL("/health", runner), { method: "GET", timeoutMs: 15_000 });
      if (!response.ok) return false;
      const body = await response.json() as { status?: unknown };
      return body.status === "ok";
    },
    publish: async (phase, since, validUntil) => {
      await prisma.runnerAvailability.upsert({ where: { id: 1 }, create: { id: 1, phase, since, validUntil }, update: { phase, since, validUntil } });
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
  const options = { ...DEFAULT_AVAILABILITY_OPTIONS, idleMs: config.idleMs, validityMs: config.validityMs };
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
