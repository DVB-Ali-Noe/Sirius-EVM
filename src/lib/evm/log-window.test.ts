import assert from "node:assert/strict";
import { test } from "node:test";
import { findLatestLog, LOG_WINDOW_BLOCKS } from "./log-window";

function reader(events: bigint[]) {
  const calls: [bigint, bigint][] = [];
  const read = async (from: bigint, to: bigint) => {
    calls.push([from, to]);
    return events.filter((block) => block >= from && block <= to);
  };
  return { calls, read };
}

test("la résolution récente est trouvée dans la première fenêtre, sans lire tout l'historique", async () => {
  const lock = BigInt(1_000_000);
  const latest = lock + BigInt(1_036_800); // trois jours de blocs après le lock
  const { calls, read } = reader([latest - BigInt(25)]);
  assert.equal(await findLatestLog(lock, latest, read), latest - BigInt(25));
  assert.deepEqual(calls, [[latest - LOG_WINDOW_BLOCKS + BigInt(1), latest]]);
});

test("aucune fenêtre ne dépasse 10 000 blocs ni ne descend sous le bloc du lock", async () => {
  const lock = BigInt(500);
  const latest = BigInt(35_123);
  const { calls, read } = reader([BigInt(600)]);
  assert.equal(await findLatestLog(lock, latest, read), BigInt(600));
  for (const [from, to] of calls) {
    assert.ok(to - from + BigInt(1) <= LOG_WINDOW_BLOCKS);
    assert.ok(from >= lock && to <= latest);
  }
  assert.equal(calls.at(-1)![0], lock);
  // Fenêtres contiguës, de haut en bas, sans trou ni chevauchement.
  for (let i = 1; i < calls.length; i++) assert.equal(calls[i][1], calls[i - 1][0] - BigInt(1));
});

test("rend le dernier journal d'une fenêtre et undefined si rien n'est trouvé", async () => {
  const { read } = reader([BigInt(10), BigInt(12)]);
  assert.equal(await findLatestLog(BigInt(0), BigInt(20), read), BigInt(12));
  const empty = reader([]);
  assert.equal(await findLatestLog(BigInt(0), BigInt(25_000), empty.read), undefined);
  assert.equal(empty.calls.length, 3);
  assert.equal(await findLatestLog(BigInt(10), BigInt(9), empty.read), undefined);
});
