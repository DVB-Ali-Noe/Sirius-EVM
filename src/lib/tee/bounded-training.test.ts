import assert from "node:assert/strict";
import { test } from "node:test";
import { modelSelection } from "@/lib/models/registry";
import { assertWithinDeadline, TrainingDeadlineExceeded, trainingClockMs } from "./train";
import { trainInWorker } from "./bounded-training";

test("ROB-07 : le délai interne épuisé est une limite du calcul, pas un défaut du fichier", () => {
  // Échéances lues sur l'horloge du délai (temps CPU du thread quand Node le fournit, EXA-05).
  assert.doesNotThrow(() => assertWithinDeadline(trainingClockMs() + 60_000));
  assert.throws(() => assertWithinDeadline(trainingClockMs() - 1), (error: unknown) => {
    assert.ok(error instanceof TrainingDeadlineExceeded);
    assert.equal((error as Error).message, "budget de calcul dépassé");
    return true;
  });
});

test("ROB-07 : le worker borné entraîne toujours un petit fichier valide", { timeout: 20_000 }, async () => {
  const rows = Array.from({ length: 200 }, (_, index) => `${index % 7},${(index * 13) % 11},${index % 2}`);
  const csv = Buffer.from(["a,b,label", ...rows].join("\n"));
  const model = await trainInWorker(modelSelection("logistic_regression", "1.0.0")!, csv, AbortSignal.timeout(15_000));
  assert.equal(model.algo, "logistic_regression");
});
