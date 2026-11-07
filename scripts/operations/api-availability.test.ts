import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availabilityConfig, availabilityDecision, availabilityTick,
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
  return { memory: memory(), loans: [], apiKeys: [], requestedUntil: null, cvm: "stopped", healthy: false, ...overrides };
}
const loan = (id: string, status: string, rentalExpiresAt: Date | null = null, overrides: Partial<AvailabilityLoanRecord> = {}): AvailabilityLoanRecord => (
  { id, status, rentalExpiresAt, evmDeadline: null, settleTxHash: null, ...overrides }
);

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
    const abandoned = loan("abandon", status, null, { evmDeadline: past });
    assert.equal(availabilityDecision(state({ loans: [abandoned] }), T0).action, null, `${status} échu`);
    assert.equal(availabilityDecision(state({ loans: [loan("p", status, null, { evmDeadline: future })] }), T0).action, "start", `${status} avant échéance`);
    assert.equal(availabilityDecision(state({ loans: [{ ...abandoned, settleTxHash: `0x${"55".repeat(32)}` }] }), T0).action, "start", `${status} release diffusé`);
  }
  // Échéance pile maintenant : échue.
  assert.equal(availabilityDecision(state({ loans: [loan("p", "ESCROWED", null, { evmDeadline: new Date(T0) })] }), T0).action, null);
});

test("une location réglée non expirée avec une clé active démarre la CVM", () => {
  const decision = availabilityDecision(state({
    loans: [loan("loc", "SETTLED", future)], apiKeys: [{ loanId: "loc", revokedAt: null }, { loanId: "loc", revokedAt: past }],
  }), T0);
  assert.equal(decision.needed, true);
  assert.equal(decision.action, "start");
});

test("location expirée, sans échéance, clé révoquée seule ou clé d'un autre prêt : aucun démarrage", () => {
  const cases: Array<Pick<AvailabilityState, "loans" | "apiKeys">> = [
    { loans: [loan("loc", "SETTLED", past)], apiKeys: [{ loanId: "loc", revokedAt: null }] },
    { loans: [loan("loc", "SETTLED", new Date(T0))], apiKeys: [{ loanId: "loc", revokedAt: null }] },
    { loans: [loan("loc", "SETTLED", null)], apiKeys: [{ loanId: "loc", revokedAt: null }] },
    { loans: [loan("loc", "SETTLED", future)], apiKeys: [{ loanId: "loc", revokedAt: past }] },
    { loans: [loan("loc", "SETTLED", future)], apiKeys: [{ loanId: "autre", revokedAt: null }] },
    { loans: [loan("loc", "SETTLED", future)], apiKeys: [] },
  ];
  for (const [index, records] of cases.entries()) {
    const decision = availabilityDecision(state(records), T0);
    assert.equal(decision.needed, false, `cas ${index}`);
    assert.equal(decision.action, null, `cas ${index}`);
    assert.equal(decision.memory.phase, "stopped", `cas ${index}`);
  }
});

test("un réveil demandé par un emprunteur démarre la CVM jusqu'à son échéance seulement", () => {
  const decision = availabilityDecision(state({ requestedUntil: new Date(T0 + 15 * MINUTE) }), T0);
  assert.equal(decision.needed, true);
  assert.equal(decision.action, "start");
  for (const requestedUntil of [new Date(T0), past]) {
    assert.equal(availabilityDecision(state({ requestedUntil }), T0).needed, false);
  }
});

test("arrêt seulement après 30 minutes sans besoin, puis stopping → stopped", () => {
  const busy = { loans: [loan("p", "TRAINING")] };
  let current = availabilityDecision(state({ ...busy, memory: memory("running"), cvm: "running", healthy: true }), T0).memory;
  assert.equal(current.lastNeededAt, T0);
  for (const minutes of [1, 15, 29]) {
    const decision = availabilityDecision(state({ memory: current, cvm: "running", healthy: true }), T0 + minutes * MINUTE);
    assert.equal(decision.action, null, `${minutes} min`);
    assert.equal(decision.memory.phase, "running");
    current = decision.memory;
  }
  // Un besoin qui réapparaît remet le compteur à zéro.
  current = availabilityDecision(state({ ...busy, memory: current, cvm: "running", healthy: true }), T0 + 29 * MINUTE).memory;
  assert.equal(availabilityDecision(state({ memory: current, cvm: "running", healthy: true }), T0 + 58 * MINUTE).action, null);
  const stop = availabilityDecision(state({ memory: current, cvm: "running", healthy: true }), T0 + 59 * MINUTE);
  assert.equal(stop.action, "stop");
  assert.equal(stop.memory.phase, "stopping");
  // La CVM s'arrête encore : pas de seconde commande immédiate.
  const pending = availabilityDecision(state({ memory: stop.memory, cvm: "running", healthy: true }), T0 + 60 * MINUTE);
  assert.equal(pending.action, null);
  assert.equal(pending.memory.phase, "stopping");
  const transitioning = availabilityDecision(state({ memory: pending.memory, cvm: "transitioning" }), T0 + 61 * MINUTE);
  assert.equal(transitioning.memory.phase, "stopping");
  const stopped = availabilityDecision(state({ memory: transitioning.memory, cvm: "stopped" }), T0 + 62 * MINUTE);
  assert.equal(stopped.memory.phase, "stopped");
  assert.equal(stopped.action, null);
  assert.equal(stopped.memory.since, T0 + 62 * MINUTE);
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

test("refus sur l'instance démo, désactivé par défaut, bornes de configuration", () => {
  assert.throws(() => availabilityConfig({ SIRIUS_API_AVAILABILITY: "true", SIRIUS_PHALA_DEMO: "true" }), /démonstration/);
  assert.throws(() => availabilityConfig({}), /SIRIUS_API_AVAILABILITY/);
  assert.throws(() => availabilityConfig({ SIRIUS_API_AVAILABILITY: "1" }), /SIRIUS_API_AVAILABILITY/);
  assert.throws(() => availabilityConfig({ SIRIUS_API_AVAILABILITY: "true", PHALA_DEMO_CVM_ID: "demo", SIRIUS_API_PHALA_CVM_ID: "demo" }), /démonstration/);
  assert.deepEqual(availabilityConfig({ SIRIUS_API_AVAILABILITY: "true" }), { idleMs: 30 * MINUTE, pollMs: 60_000 });
  assert.deepEqual(availabilityConfig({ SIRIUS_API_AVAILABILITY: "true", SIRIUS_API_AVAILABILITY_IDLE_MINUTES: "45", SIRIUS_API_AVAILABILITY_POLL_SECONDS: "30" }),
    { idleMs: 45 * MINUTE, pollMs: 30_000 });
  for (const value of ["0", "4", "1441", "1.5", "abc"]) {
    assert.throws(() => availabilityConfig({ SIRIUS_API_AVAILABILITY: "true", SIRIUS_API_AVAILABILITY_IDLE_MINUTES: value }), /IDLE_MINUTES/);
  }
});

test("un tour publie la phase, ne vérifie la santé que CVM allumée, et réessaie une commande refusée", async () => {
  const world = { power: "stopped" as CvmPower, starts: 0, healthCalls: 0, failStart: true, published: [] as string[], dbDown: false };
  const io: AvailabilityIO = {
    records: async () => {
      if (world.dbDown) throw new Error("base");
      return { loans: [loan("p", "ESCROWED")], apiKeys: [], requestedUntil: null };
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
