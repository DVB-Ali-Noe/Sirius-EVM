import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOCK_FINALITY_POLL_MAX_MS,
  LOCK_FINALITY_POLL_MIN_MS,
  estimateLockFinality,
  lockFinalityMinutesLeft,
  nextLockFinalityCheckMs,
  parseLockFinalityResponse,
} from "./lock-finality";

const NOW = Date.UTC(2026, 9, 7, 10, 0, 0);

test("un lock sous le bloc stable n'attend plus, quel que soit l'écart d'horodatage", () => {
  for (const stableBlock of [BigInt(100), BigInt(150)]) {
    const estimate = estimateLockFinality(
      { lockBlock: BigInt(100), lockTimestamp: BigInt(1_000), stableBlock, stableTimestamp: BigInt(10) },
      NOW,
    );
    assert.deepEqual(estimate, { pending: false, remainingMs: 0, estimatedReadyAt: NOW });
  }
});

test("un lock au-dessus du bloc stable attend l'écart entre son horodatage et celui du bloc stable", () => {
  // Bloc stable horodaté 14 minutes avant le lock (≈ 8 500 blocs sur Robinhood Chain) : 14 min d'attente.
  const estimate = estimateLockFinality(
    { lockBlock: BigInt(9_000), lockTimestamp: BigInt(1_000 + 14 * 60), stableBlock: BigInt(500), stableTimestamp: BigInt(1_000) },
    NOW,
  );
  assert.deepEqual(estimate, { pending: true, remainingMs: 14 * 60_000, estimatedReadyAt: NOW + 14 * 60_000 });
  // Mode confirmations (testnet) : un bloc d'écart, quelques secondes.
  assert.deepEqual(
    estimateLockFinality({ lockBlock: BigInt(11), lockTimestamp: BigInt(1_002), stableBlock: BigInt(10), stableTimestamp: BigInt(1_000) }, NOW),
    { pending: true, remainingMs: 2_000, estimatedReadyAt: NOW + 2_000 },
  );
  // Horodatages incohérents (RPC en retard) : jamais de durée négative.
  assert.deepEqual(
    estimateLockFinality({ lockBlock: BigInt(11), lockTimestamp: BigInt(900), stableBlock: BigInt(10), stableTimestamp: BigInt(1_000) }, NOW),
    { pending: true, remainingMs: 0, estimatedReadyAt: NOW },
  );
});

test("les minutes restantes sont arrondies au supérieur et jamais négatives", () => {
  assert.equal(lockFinalityMinutesLeft(NOW + 14 * 60_000, NOW), 14);
  assert.equal(lockFinalityMinutesLeft(NOW + 13 * 60_000 + 1, NOW), 14);
  assert.equal(lockFinalityMinutesLeft(NOW + 1, NOW), 1);
  assert.equal(lockFinalityMinutesLeft(NOW, NOW), 0);
  assert.equal(lockFinalityMinutesLeft(NOW - 60_000, NOW), 0);
});

test("la relecture vise l'instant estimé, bornée entre 20 s et 60 s", () => {
  assert.equal(LOCK_FINALITY_POLL_MIN_MS, 20_000);
  assert.equal(LOCK_FINALITY_POLL_MAX_MS, 60_000);
  assert.equal(nextLockFinalityCheckMs(NOW + 14 * 60_000, NOW), 60_000);
  assert.equal(nextLockFinalityCheckMs(NOW + 45_000, NOW), 45_000);
  assert.equal(nextLockFinalityCheckMs(NOW + 5_000, NOW), 20_000);
  assert.equal(nextLockFinalityCheckMs(NOW, NOW), 20_000);
  assert.equal(nextLockFinalityCheckMs(NOW - 60_000, NOW), 20_000);
});

test("la réponse du serveur est lue de façon défensive : seul pending: true met en attente, durée serveur en ms", () => {
  assert.deepEqual(parseLockFinalityResponse({ pending: true, remainingMs: 60_000, estimatedReadyAt: "2026-10-07T10:01:00.000Z" }), { pending: true, remainingMs: 60_000 });
  assert.deepEqual(parseLockFinalityResponse({ pending: true, remainingMs: 0 }), { pending: true, remainingMs: 0 });
  for (const remainingMs of ["60000", -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
    assert.deepEqual(parseLockFinalityResponse({ pending: true, remainingMs }), { pending: true, remainingMs: null }, String(remainingMs));
  }
  for (const body of [{ pending: false, remainingMs: null }, { pending: "true" }, { known: true }, {}, null, undefined, "pending", []]) {
    assert.deepEqual(parseLockFinalityResponse(body), { pending: false, remainingMs: null });
  }
});
