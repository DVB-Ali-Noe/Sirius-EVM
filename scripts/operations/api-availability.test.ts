import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  availabilityConfig, availabilityDecision, availabilityTick, DEFAULT_AVAILABILITY_OPTIONS, inFlightLoanNeeded, inFlightLoanWhere,
  type AvailabilityIO, type AvailabilityLoanRecord, type AvailabilityMemory, type AvailabilityPhase, type AvailabilityState,
} from "./api-availability";
import type { CvmPower } from "./phala-cvm";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 7, 12);
const future = new Date(T0 + 3 * 86_400_000);
const past = new Date(T0 - MINUTE);

function memory(phase: AvailabilityPhase = "stopped", overrides: Partial<AvailabilityMemory> = {}): AvailabilityMemory {
  return { phase, since: T0 - 60 * MINUTE, lastNeededAt: T0 - 60 * MINUTE, unreachableSince: null, lastAlertAt: null, lastCommand: null, ...overrides };
}
function state(overrides: Partial<AvailabilityState>): AvailabilityState {
  return { memory: memory(), loans: [], requestedUntil: null, cvm: "stopped", healthy: false, ...overrides };
}
const DAY = 86_400_000;
const loan = (id: string, status: string, overrides: Partial<AvailabilityLoanRecord> = {}): AvailabilityLoanRecord => ({
  id, status, evmDeadline: null, settleTxHash: null, createdAt: new Date(T0), extendsLoanId: null, packForLoanId: null,
  apiAccessRefusedAt: null, originRentalExpiresAt: null, ...overrides,
});

test("un prêt, une prolongation ou un pack en cours démarre la CVM arrêtée", () => {
  for (const status of ["ESCROWED", "TRAINING", "SETTLING"]) {
    for (const record of [loan("origine", status), { ...loan("prolongation", status), extendsLoanId: "origine" }, { ...loan("pack", status), packForLoanId: "origine" }]) {
      const decision = availabilityDecision(state({ loans: [record] }), T0);
      assert.equal(decision.needed, true, `${status} ${record.id}`);
      assert.equal(decision.action, "start");
      assert.equal(decision.memory.phase, "starting");
      assert.equal(decision.memory.since, T0);
    }
  }
  for (const status of ["PENDING", "SUBMITTING", "CANCELLED"]) {
    assert.equal(availabilityDecision(state({ loans: [loan("x", status)] }), T0).action, null, status);
  }
});

test("lock échu sans release diffusé : abandonné, la CVM ne démarre pas ; lock non échu ou release diffusé : démarrage", () => {
  for (const status of ["ESCROWED", "TRAINING", "SETTLING"]) {
    const abandoned = loan("abandon", status, { evmDeadline: past });
    assert.equal(availabilityDecision(state({ loans: [abandoned] }), T0).action, null, `${status} échu`);
    assert.equal(availabilityDecision(state({ loans: [loan("p", status, { evmDeadline: future })] }), T0).action, "start", `${status} avant échéance`);
    assert.equal(availabilityDecision(state({ loans: [{ ...abandoned, settleTxHash: `0x${"55".repeat(32)}` }] }), T0).action, "start", `${status} release diffusé`);
  }
  // Échéance pile maintenant : échue.
  assert.equal(availabilityDecision(state({ loans: [loan("p", "ESCROWED", { evmDeadline: new Date(T0) })] }), T0).action, null);
});

test("option 1 : une location réglée, même portant une clé active, ne démarre ni ne retient la CVM", () => {
  const rented = { loans: [loan("loc", "SETTLED")] };
  const cold = availabilityDecision(state(rented), T0);
  assert.equal(cold.needed, false);
  assert.equal(cold.action, null);
  assert.equal(cold.memory.phase, "stopped");
  // Allumée sans autre besoin depuis le délai d'inactivité : arrêt, la location n'y change rien.
  const idle = availabilityDecision(state({ ...rented, memory: memory("running", { lastNeededAt: T0 - 45 * MINUTE }), cvm: "running", healthy: true }), T0);
  assert.equal(idle.action, "stop");
});

test("un réveil demandé démarre la CVM jusqu'à son échéance seulement", () => {
  const decision = availabilityDecision(state({ requestedUntil: new Date(T0 + 15 * MINUTE) }), T0);
  assert.equal(decision.needed, true);
  assert.equal(decision.action, "start");
  for (const requestedUntil of [new Date(T0), past]) {
    assert.equal(availabilityDecision(state({ requestedUntil }), T0).needed, false);
  }
});

test("arrêt seulement après 45 minutes sans besoin, puis stopping → stopped", () => {
  const busy = { loans: [loan("p", "TRAINING")] };
  let current = availabilityDecision(state({ ...busy, memory: memory("running"), cvm: "running", healthy: true }), T0).memory;
  assert.equal(current.lastNeededAt, T0);
  for (const minutes of [1, 15, 30, 44]) {
    const decision = availabilityDecision(state({ memory: current, cvm: "running", healthy: true }), T0 + minutes * MINUTE);
    assert.equal(decision.action, null, `${minutes} min`);
    assert.equal(decision.memory.phase, "running");
    current = decision.memory;
  }
  // Un besoin qui réapparaît remet le compteur à zéro.
  current = availabilityDecision(state({ ...busy, memory: current, cvm: "running", healthy: true }), T0 + 44 * MINUTE).memory;
  assert.equal(availabilityDecision(state({ memory: current, cvm: "running", healthy: true }), T0 + 88 * MINUTE).action, null);
  const stop = availabilityDecision(state({ memory: current, cvm: "running", healthy: true }), T0 + 89 * MINUTE);
  assert.equal(stop.action, "stop");
  assert.equal(stop.memory.phase, "stopping");
  // La CVM s'arrête encore : pas de seconde commande immédiate.
  const pending = availabilityDecision(state({ memory: stop.memory, cvm: "running", healthy: true }), T0 + 90 * MINUTE);
  assert.equal(pending.action, null);
  assert.equal(pending.memory.phase, "stopping");
  const transitioning = availabilityDecision(state({ memory: pending.memory, cvm: "transitioning" }), T0 + 91 * MINUTE);
  assert.equal(transitioning.memory.phase, "stopping");
  const stopped = availabilityDecision(state({ memory: transitioning.memory, cvm: "stopped" }), T0 + 92 * MINUTE);
  assert.equal(stopped.memory.phase, "stopped");
  assert.equal(stopped.action, null);
  assert.equal(stopped.memory.since, T0 + 92 * MINUTE);
});

test("dernière activité à T0 (réveil jusqu'à T0 + 15 min) : arrêt environ une heure après, pas avant", () => {
  const requestedUntil = new Date(T0 + 15 * MINUTE);
  let current = memory("running", { lastNeededAt: T0 });
  let stoppedAt: number | null = null;
  for (let minute = 0; minute <= 70 && stoppedAt === null; minute++) {
    const decision = availabilityDecision(state({ requestedUntil, memory: current, cvm: "running", healthy: true }), T0 + minute * MINUTE);
    if (decision.action === "stop") stoppedAt = minute;
    current = decision.memory;
  }
  // Dernier tour avec besoin à T0 + 14 min, puis 45 min d'inactivité.
  assert.equal(stoppedAt, 59);
});

test("starting → running seulement quand /health répond, sans redemander le démarrage", () => {
  const busy = { loans: [loan("p", "ESCROWED")] };
  const start = availabilityDecision(state(busy), T0);
  assert.equal(start.action, "start");
  const booting = availabilityDecision(state({ ...busy, memory: start.memory, cvm: "transitioning" }), T0 + MINUTE);
  assert.equal(booting.memory.phase, "starting");
  assert.equal(booting.action, null);
  const stillStopped = availabilityDecision(state({ ...busy, memory: booting.memory, cvm: "stopped" }), T0 + 2 * MINUTE);
  assert.equal(stillStopped.action, null, "commande récente : pas de rafale de démarrages");
  const unhealthy = availabilityDecision(state({ ...busy, memory: stillStopped.memory, cvm: "running", healthy: false }), T0 + 3 * MINUTE);
  assert.equal(unhealthy.memory.phase, "starting");
  assert.equal(unhealthy.memory.since, T0);
  const healthy = availabilityDecision(state({ ...busy, memory: unhealthy.memory, cvm: "running", healthy: true }), T0 + 4 * MINUTE);
  assert.equal(healthy.memory.phase, "running");
  assert.equal(healthy.memory.since, T0 + 4 * MINUTE);
  // Une CVM toujours arrêtée après le délai de nouvel essai est relancée.
  assert.equal(availabilityDecision(state({ ...busy, memory: stillStopped.memory, cvm: "stopped" }), T0 + 6 * MINUTE).action, "start");
});

test("alerte après 10 minutes injoignable alors que nécessaire, répétée toutes les 10 minutes, levée au retour", () => {
  const busy = { loans: [loan("p", "SETTLING")] };
  let current = memory("starting");
  const alerts: number[] = [];
  for (let minute = 0; minute <= 21; minute++) {
    const decision = availabilityDecision(state({ ...busy, memory: current, cvm: "running", healthy: false }), T0 + minute * MINUTE);
    if (decision.alert) { alerts.push(minute); assert.match(decision.alert, /^ALERTE /); }
    current = decision.memory;
  }
  assert.deepEqual(alerts, [11, 21]);
  current = availabilityDecision(state({ ...busy, memory: current, cvm: "running", healthy: true }), T0 + 22 * MINUTE).memory;
  assert.equal(current.unreachableSince, null);
  assert.equal(availabilityDecision(state({ ...busy, memory: current, cvm: "running", healthy: false }), T0 + 23 * MINUTE).alert, null);
  // Sans besoin, une CVM injoignable n'alerte pas.
  let idle = memory("starting");
  for (let minute = 0; minute <= 15; minute++) {
    const decision = availabilityDecision(state({ memory: idle, cvm: "transitioning" }), T0 + minute * MINUTE);
    assert.equal(decision.alert, null);
    idle = decision.memory;
  }
});

test("état Phala illisible : aucune commande et plus de phase running non prouvée", () => {
  const decision = availabilityDecision(state({ loans: [loan("p", "TRAINING")], memory: memory("running"), cvm: "unknown" }), T0);
  assert.equal(decision.action, null);
  assert.equal(decision.memory.phase, "starting");
  assert.equal(availabilityDecision(state({ memory: memory("running", { lastNeededAt: T0 - 90 * MINUTE }), cvm: "unknown" }), T0).action, null);
});

const hex = (length: number) => "ab".repeat(length / 2);
/** Environnement complet et valide du contrôleur API. */
const API_APP_ID = hex(40);
const DEMO_APP_ID = "cd".repeat(20);
const validEnv = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  SIRIUS_API_AVAILABILITY: "true",
  SIRIUS_API_PHALA_PROFILE: "sirius-api", SIRIUS_API_PHALA_CVM_ID: "sirius-api-cvm", SIRIUS_API_PHALA_APP_ID: API_APP_ID,
  SIRIUS_PHALA_DEMO_APP_ID: DEMO_APP_ID,
  RUNNER_URL: "https://runner.example",
  SIRIUS_EXPECTED_MRTD: hex(96), SIRIUS_EXPECTED_RTMR0: hex(96), SIRIUS_EXPECTED_RTMR1: hex(96), SIRIUS_EXPECTED_RTMR2: hex(96),
  SIRIUS_EXPECTED_OS_IMAGE_HASH: hex(64), SIRIUS_EXPECTED_APP_ID: API_APP_ID, SIRIUS_EXPECTED_COMPOSE_HASH: hex(64),
  SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256: hex(64), NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256: hex(64),
  ...overrides,
});

test("refus sur l'instance démo, désactivé par défaut, bornes de configuration", () => {
  assert.throws(() => availabilityConfig(validEnv({ SIRIUS_PHALA_DEMO: "true" })), /démonstration/);
  assert.throws(() => availabilityConfig(validEnv({ SIRIUS_API_AVAILABILITY: undefined })), /SIRIUS_API_AVAILABILITY/);
  assert.throws(() => availabilityConfig(validEnv({ SIRIUS_API_AVAILABILITY: "1" })), /SIRIUS_API_AVAILABILITY/);
  assert.throws(() => availabilityConfig(validEnv({ PHALA_DEMO_CVM_ID: "sirius-api-cvm" })), /démonstration/);
  const config = availabilityConfig(validEnv());
  assert.equal(config.idleMs, 45 * MINUTE);
  assert.equal(config.pollMs, 60_000);
  assert.deepEqual(config.phala, { profile: "sirius-api", cvm: "sirius-api-cvm", appId: API_APP_ID });
  assert.equal(config.runnerUrl.origin, "https://runner.example");
  const custom = availabilityConfig(validEnv({ SIRIUS_API_AVAILABILITY_IDLE_MINUTES: "60", SIRIUS_API_AVAILABILITY_POLL_SECONDS: "30" }));
  assert.deepEqual([custom.idleMs, custom.pollMs], [60 * MINUTE, 30_000]);
  for (const value of ["0", "4", "1441", "1.5", "abc"]) {
    assert.throws(() => availabilityConfig(validEnv({ SIRIUS_API_AVAILABILITY_IDLE_MINUTES: value })), /IDLE_MINUTES/);
  }
  assert.throws(() => availabilityConfig(validEnv({ RUNNER_URL: "http://runner.example" })), /HTTPS/);
});

test("F6 : refus quand l'app ID piloté est celui déclaré pour la démonstration, même sans PHALA_DEMO_CVM_ID", () => {
  // Fichier d'environnement séparé du contrôleur démo : seule la déclaration propre au contrôleur API compte.
  assert.throws(() => availabilityConfig(validEnv({ SIRIUS_PHALA_DEMO_APP_ID: API_APP_ID })), /démonstration/);
  assert.throws(() => availabilityConfig(validEnv({ SIRIUS_PHALA_DEMO_APP_ID: API_APP_ID.toUpperCase() })), /démonstration/);
  assert.throws(() => availabilityConfig(validEnv({ SIRIUS_API_PHALA_APP_ID: API_APP_ID.toUpperCase(), SIRIUS_PHALA_DEMO_APP_ID: API_APP_ID })), /démonstration/);
  assert.throws(() => availabilityConfig(validEnv({ PHALA_DEMO_APP_ID: API_APP_ID })), /démonstration/);
  // Déclaration obligatoire : absente ou mal formée, le contrôleur ne démarre pas.
  assert.throws(() => availabilityConfig(validEnv({ SIRIUS_PHALA_DEMO_APP_ID: undefined })), /SIRIUS_PHALA_DEMO_APP_ID requis/);
  assert.throws(() => availabilityConfig(validEnv({ SIRIUS_PHALA_DEMO_APP_ID: "demo" })), /SIRIUS_PHALA_DEMO_APP_ID invalide/);
  assert.throws(() => availabilityConfig(validEnv({ SIRIUS_API_PHALA_APP_ID: "demo" })), /SIRIUS_API_PHALA_APP_ID invalide/);
  // Aucune démonstration sur ce compte Phala : déclaration explicite.
  assert.equal(availabilityConfig(validEnv({ SIRIUS_PHALA_DEMO_APP_ID: "none" })).phala.appId, API_APP_ID);
});

test("F5 : pins du runner validés au démarrage, et le modèle d'environnement les déclare tous (sans RTMR3)", () => {
  for (const name of ["SIRIUS_EXPECTED_RTMR0", "SIRIUS_EXPECTED_RTMR1", "SIRIUS_EXPECTED_RTMR2", "SIRIUS_EXPECTED_OS_IMAGE_HASH", "SIRIUS_EXPECTED_APP_ID", "SIRIUS_EXPECTED_MRTD"]) {
    assert.throws(() => availabilityConfig(validEnv({ [name]: undefined })), new RegExp(name), name);
    assert.throws(() => availabilityConfig(validEnv({ [name]: "REPLACE_VERIFIED" })), new RegExp(name), name);
  }
  // Chaque variable exigée figure dans le modèle : l'environnement réduit à ses clés reste valide.
  const keys = (file: string) => new Set(readFileSync(new URL(`../../deploy/operations/${file}`, import.meta.url), "utf8")
    .split("\n").map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1]).filter((key): key is string => Boolean(key)));
  const template = keys("api-availability.env.example");
  const full = validEnv({ SIRIUS_API_AVAILABILITY_IDLE_MINUTES: "45", SIRIUS_API_AVAILABILITY_POLL_SECONDS: "60" });
  const reduced = Object.fromEntries(Object.entries(full).filter(([key]) => template.has(key)));
  assert.doesNotThrow(() => availabilityConfig(reduced));
  for (const file of ["api-availability.env.example", "phala-demo-controller.env.example"]) {
    const declared = keys(file);
    assert.equal(declared.has("SIRIUS_EXPECTED_RTMR3"), false, `${file} : RTMR3 n'est plus lu`);
    for (const pin of ["SIRIUS_EXPECTED_RTMR0", "SIRIUS_EXPECTED_RTMR1", "SIRIUS_EXPECTED_RTMR2", "SIRIUS_EXPECTED_OS_IMAGE_HASH", "SIRIUS_EXPECTED_APP_ID"]) {
      assert.ok(declared.has(pin), `${file} : ${pin}`);
    }
  }
});

test("un tour publie la phase, ne vérifie la santé que CVM allumée, et réessaie une commande refusée", async () => {
  const world = { power: "stopped" as CvmPower, starts: 0, healthCalls: 0, failStart: true, published: [] as string[], dbDown: false };
  const io: AvailabilityIO = {
    records: async () => {
      if (world.dbDown) throw new Error("base");
      return { loans: [loan("p", "ESCROWED")], requestedUntil: null };
    },
    getCvm: async () => world.power,
    startCvm: async () => { world.starts++; if (world.failStart) throw new Error("phala"); world.power = "running"; },
    stopCvm: async () => { world.power = "stopped"; },
    health: async () => { world.healthCalls++; return true; },
    publish: async (phase) => { world.published.push(phase); },
    log: () => {},
    alert: () => {},
  };
  let current = await availabilityTick(memory(), io, T0);
  assert.equal(world.starts, 1);
  assert.equal(world.healthCalls, 0);
  assert.equal(current.lastCommand, null, "commande refusée : nouvel essai possible");
  world.failStart = false;
  current = await availabilityTick(current, io, T0 + MINUTE);
  assert.equal(world.starts, 2);
  current = await availabilityTick(current, io, T0 + 2 * MINUTE);
  assert.equal(world.healthCalls, 1);
  assert.equal(current.phase, "running");
  assert.deepEqual(world.published, ["starting", "starting", "running"]);
  world.dbDown = true;
  world.power = "stopped";
  const unchanged = await availabilityTick(current, io, T0 + 3 * MINUTE);
  assert.equal(unchanged, current, "base indisponible : aucune décision");
  assert.equal(world.published.length, 3);
});

// --- Audit E F2 : un prêt verrouillé ne garde la CVM que tant que le runner a du travail ------------

const RELEASE = `0x${"55".repeat(32)}`;

/** Cas couvrant chaque branche de la règle, avec le besoin attendu à T0. */
const neededCases: [string, AvailabilityLoanRecord, boolean][] = [
  ["prêt ESCROWED préparé il y a 39 min (lock au plus tard 10 min après)", loan("a", "ESCROWED", { createdAt: new Date(T0 - 39 * MINUTE), evmDeadline: future }), true],
  ["prêt ESCROWED préparé il y a 41 min, jamais lancé", loan("b", "ESCROWED", { createdAt: new Date(T0 - 41 * MINUTE), evmDeadline: future }), false],
  ["prêt ESCROWED ancien sans échéance lue", loan("c", "ESCROWED", { createdAt: new Date(T0 - DAY) }), false],
  ["prêt TRAINING ancien", loan("d", "TRAINING", { createdAt: new Date(T0 - DAY), evmDeadline: future }), true],
  ["prêt SETTLING ancien", loan("e", "SETTLING", { createdAt: new Date(T0 - DAY), evmDeadline: future }), true],
  ["prêt ESCROWED ancien avec release diffusé", loan("f", "ESCROWED", { createdAt: new Date(T0 - DAY), settleTxHash: RELEASE }), true],
  ["pack ancien, location d'origine en cours", loan("g", "ESCROWED", { packForLoanId: "o", createdAt: new Date(T0 - DAY), evmDeadline: future, originRentalExpiresAt: new Date(T0 + DAY) }), true],
  ["pack, échéance d'origine pas encore lue", loan("h", "ESCROWED", { packForLoanId: "o", createdAt: new Date(T0 - DAY), evmDeadline: future }), true],
  ["pass refusé (apiAccessRefusedAt)", loan("i", "ESCROWED", { packForLoanId: "o", apiAccessRefusedAt: new Date(T0 - DAY), evmDeadline: future, originRentalExpiresAt: new Date(T0 + DAY) }), false],
  ["pack refusé : location d'origine échue (RENTAL_EXPIRED)", loan("j", "ESCROWED", { packForLoanId: "o", evmDeadline: future, originRentalExpiresAt: new Date(T0 - MINUTE) }), false],
  ["pack release diffusé, location d'origine échue", loan("k", "SETTLING", { packForLoanId: "o", settleTxHash: RELEASE, originRentalExpiresAt: new Date(T0 - MINUTE) }), true],
  ["prolongation, location échue mais modèle gardé", loan("l", "ESCROWED", { extendsLoanId: "o", evmDeadline: future, originRentalExpiresAt: new Date(T0 - 29 * DAY) }), true],
  ["prolongation refusée : modèle supprimé (RENTAL_MODEL_DELETED)", loan("m", "ESCROWED", { extendsLoanId: "o", evmDeadline: future, originRentalExpiresAt: new Date(T0 - 31 * DAY) }), false],
  ["pack au lock échu", loan("n", "ESCROWED", { packForLoanId: "o", evmDeadline: past, originRentalExpiresAt: new Date(T0 + DAY) }), false],
  ["prêt réglé", loan("p", "SETTLED", { createdAt: new Date(T0) }), false],
];

test("F2 : prêt ordinaire 30 min après son lock (40 min après sa préparation), packs et prolongations jusqu'à une issue, jamais au-delà", () => {
  for (const [label, record, expected] of neededCases) {
    assert.equal(inFlightLoanNeeded(record, T0), expected, label);
    assert.equal(availabilityDecision(state({ loans: [record] }), T0).needed, expected, label);
  }
});

type Where = Record<string, unknown>;
/** Évaluation du sous-ensemble Prisma produit par `inFlightLoanWhere` (AND, OR, is, in, not, gt). */
function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "AND") return (condition as Where[]).every((branch) => matches(row, branch));
    if (key === "OR") return (condition as Where[]).some((branch) => matches(row, branch));
    const value = row[key] ?? null;
    if (condition === null || typeof condition !== "object" || condition instanceof Date) return value === condition;
    const ops = condition as Where;
    if ("is" in ops) return value !== null && matches(value as Record<string, unknown>, ops.is as Where);
    return Object.entries(ops).every(([op, expected]) => {
      if (op === "in") return (expected as unknown[]).includes(value);
      if (op === "not") return value !== expected;
      if (op === "gt") return value instanceof Date && value.getTime() > (expected as Date).getTime();
      throw new Error(`opérateur non couvert : ${op}`);
    });
  });
}

test("F2 : le filtre en base du contrôleur retient exactement les mêmes prêts que la règle", () => {
  const where = inFlightLoanWhere(new Date(T0));
  for (const [label, record, expected] of neededCases) {
    const origin = record.originRentalExpiresAt === null ? { rentalExpiresAt: null } : { rentalExpiresAt: record.originRentalExpiresAt };
    const row = {
      ...record,
      packForLoan: record.packForLoanId ? origin : null,
      extendsLoan: record.extendsLoanId ? origin : null,
    };
    assert.equal(matches(row, where), expected, label);
  }
});

test("F2 : un lock payé jamais lancé n'allume plus la CVM trois jours : arrêt environ 85 min après la préparation", () => {
  const locked = loan("lock", "ESCROWED", { createdAt: new Date(T0), evmDeadline: future });
  let current = memory("running", { lastNeededAt: T0 });
  let stoppedAt: number | null = null;
  for (let minute = 0; minute <= 3 * 24 * 60 && stoppedAt === null; minute++) {
    const decision = availabilityDecision(state({ loans: [locked], memory: current, cvm: "running", healthy: true }), T0 + minute * MINUTE);
    if (decision.action === "stop") stoppedAt = minute;
    current = decision.memory;
  }
  // Dernier tour avec besoin à T0 + 39 min, puis 45 min d'inactivité.
  assert.equal(stoppedAt, 84);
});

test("F2 (revue PR #159) : des /run en échec qui réécrivent le prêt ne repoussent pas la fenêtre", () => {
  // Préparé à T0, puis un /run raté toutes les 25 min : chaque échec réécrit `updatedAt` (TRAINING → ESCROWED).
  const where = (now: number) => inFlightLoanWhere(new Date(now));
  for (let minute = 0; minute <= 3 * 24 * 60; minute += 25) {
    const row = { ...loan("poke", "ESCROWED", { createdAt: new Date(T0), evmDeadline: future }), updatedAt: new Date(T0 + minute * MINUTE), packForLoan: null, extendsLoan: null };
    const now = T0 + minute * MINUTE;
    const expected = minute < 40;
    assert.equal(inFlightLoanNeeded(row, now), expected, `règle à T0 + ${minute} min`);
    assert.equal(matches(row, where(now)), expected, `filtre en base à T0 + ${minute} min`);
  }
});

// --- Audit E F3 : arrêt en deux temps ----------------------------------------------------------

function stoppingWorld(secondRead: () => Promise<{ loans: AvailabilityLoanRecord[]; requestedUntil: Date | null }>) {
  const events: string[] = [];
  let reads = 0;
  const io: AvailabilityIO = {
    records: async () => (++reads === 1 ? { loans: [], requestedUntil: null } : secondRead()),
    getCvm: async () => "running",
    startCvm: async () => { events.push("start"); },
    stopCvm: async () => { events.push("stop"); },
    health: async () => true,
    publish: async (phase, _since, validUntil) => { events.push(`publish:${phase}`); assert.ok(validUntil instanceof Date); },
    log: () => {},
    alert: () => {},
  };
  return { io, events };
}
const idleRunning = () => memory("running", { lastNeededAt: T0 - 45 * MINUTE });

test("F3 : stopping est publié avant l'arrêt, puis les besoins sont relus ; un réveil arrivé entre-temps garde la CVM", async () => {
  const kept = stoppingWorld(async () => ({ loans: [], requestedUntil: new Date(T0 + 15 * MINUTE) }));
  const next = await availabilityTick(idleRunning(), kept.io, T0);
  assert.deepEqual(kept.events, ["publish:stopping", "publish:running"], "aucune commande d'arrêt");
  assert.equal(next.phase, "running");
  assert.equal(next.since, idleRunning().since, "phase running ininterrompue");
  assert.equal(next.lastNeededAt, T0, "le délai d'inactivité repart");
  assert.equal(next.lastCommand, null);

  const stopped = stoppingWorld(async () => ({ loans: [], requestedUntil: null }));
  const after = await availabilityTick(idleRunning(), stopped.io, T0);
  assert.deepEqual(stopped.events, ["publish:stopping", "stop", "publish:stopping"]);
  assert.equal(after.phase, "stopping");
  assert.deepEqual(after.lastCommand, { action: "stop", at: T0 });

  // Relecture impossible : prudence, la CVM reste allumée et l'arrêt sera retenté au tour suivant.
  const unreadable = stoppingWorld(async () => { throw new Error("base"); });
  const retry = await availabilityTick(idleRunning(), unreadable.io, T0);
  assert.deepEqual(unreadable.events, ["publish:stopping", "publish:running"]);
  assert.equal(retry.lastNeededAt, idleRunning().lastNeededAt, "pas de besoin inventé");
  // Publication de stopping refusée : aucun arrêt sans annonce préalable.
  const silent = stoppingWorld(async () => ({ loans: [], requestedUntil: null }));
  silent.io.publish = async () => { silent.events.push("publish-failed"); throw new Error("base"); };
  await availabilityTick(idleRunning(), silent.io, T0);
  assert.equal(silent.events.includes("stop"), false);
});

// --- Audit E F4 : la phase publiée porte sa fraîcheur --------------------------------------------

test("F4 : chaque publication porte validUntil = tour + 3 intervalles + durée maximale d'un tour", async () => {
  const published: Date[] = [];
  const io: AvailabilityIO = {
    records: async () => ({ loans: [], requestedUntil: null }),
    getCvm: async () => "stopped", startCvm: async () => {}, stopCvm: async () => {},
    health: async () => true,
    publish: async (_phase, _since, validUntil) => { published.push(validUntil); },
    log: () => {}, alert: () => {},
  };
  await availabilityTick(memory(), io, T0);
  assert.equal(published[0].getTime(), T0 + DEFAULT_AVAILABILITY_OPTIONS.validityMs);
  assert.equal(DEFAULT_AVAILABILITY_OPTIONS.validityMs, 3 * 60_000 + 90_000);
  assert.equal(availabilityConfig(validEnv({ SIRIUS_API_AVAILABILITY_POLL_SECONDS: "120" })).validityMs, 3 * 120_000 + 90_000);
});
