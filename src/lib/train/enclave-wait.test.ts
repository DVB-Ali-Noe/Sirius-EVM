import assert from "node:assert/strict";
import { test } from "node:test";
import { EnclaveStartingError, retryWhileEnclaveStarts } from "./enclave-wait";

test("relance tant que l'enclave démarre, puis rend le résultat ; onWaiting annonce chaque attente et la fin", async () => {
  let runs = 0;
  const waits: (number | null)[] = [];
  const result = await retryWhileEnclaveStarts(async () => {
    runs++;
    if (runs < 3) throw new EnclaveStartingError(45);
    return "ok";
  }, { onWaiting: (seconds) => waits.push(seconds), wait: async () => {} });
  assert.equal(result, "ok");
  assert.equal(runs, 3);
  assert.deepEqual(waits, [45, 45, null]);
});

test("signal coupé pendant l'attente : l'attente s'interrompt et plus aucun essai n'est lancé", async () => {
  const controller = new AbortController();
  let runs = 0;
  const waits: (number | null)[] = [];
  const pending = retryWhileEnclaveStarts(async () => {
    runs++;
    throw new EnclaveStartingError(45);
  }, { signal: controller.signal, onWaiting: (seconds) => waits.push(seconds) });
  // Premier essai refusé, attente réelle de 45 s en cours : le démontage la coupe aussitôt.
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("démonté"));
  await assert.rejects(pending, /démonté/);
  assert.equal(runs, 1);
  assert.deepEqual(waits, [45, null]);
});

test("signal déjà coupé : aucun essai", async () => {
  const controller = new AbortController();
  controller.abort();
  let runs = 0;
  await assert.rejects(retryWhileEnclaveStarts(async () => { runs++; }, { signal: controller.signal }));
  assert.equal(runs, 0);
});
