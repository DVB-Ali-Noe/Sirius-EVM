/**
 * Valeurs numériques extrêmes acceptées par l'ingestion (|x| <= 1e12) : l'entraînement doit
 * aboutir avec des métriques finies, sans « 422 après acceptation ».
 *
 *   TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/robustesse/numeric-edges.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { gateModel } from "@/lib/tee/output-gate";
import type { TrainedModel } from "@/lib/tee/train";
import { ingest, LINEAR, LOGISTIC, metricsFinite, train } from "./hostile";

function file(rows: number, feature: (i: number) => string, target: (i: number) => string, extra = (i: number) => String(i % 13)): string {
  const lines = ["a,b,y"];
  for (let i = 0; i < rows; i++) lines.push(`${feature(i)},${extra(i)},${target(i)}`);
  return `${lines.join("\n")}\n`;
}

const CASES: Record<string, string> = {
  "±1e12": file(200, (i) => (i % 2 ? "1e12" : "-1e12"), (i) => String(i % 2)),
  "variable constante": file(200, () => "7", (i) => String(i % 2)),
  "colonnes dupliquées": file(200, (i) => String(i % 13), (i) => String(i % 2)),
  "lignes identiques hors cible": file(200, () => "1", (i) => String(i % 2), () => "1"),
  "1e-300 / 0": file(200, (i) => (i % 2 ? "1e-300" : "0"), (i) => String(i % 2)),
  "1e-310 (sous-normal) / 0": file(200, (i) => (i % 2 ? "1e-310" : "0"), (i) => String(i % 2)),
  "-0 partout": file(200, () => "-0", (i) => String(i % 2)),
};

test("valeurs extrêmes : acceptées puis entraînées, métriques finies, sortie admise par l'output-gate", () => {
  for (const [name, csv] of Object.entries(CASES)) {
    for (const selection of [LOGISTIC, LINEAR]) {
      assert.equal(ingest(csv, selection).kind, "accepted", `${name} ${selection.modelId}`);
      const trained = train(csv, selection);
      assert.equal(trained.kind, "trained", `${name} ${selection.modelId}`);
      if (trained.kind !== "trained") continue;
      assert.ok(metricsFinite(trained.model));
      assert.doesNotThrow(() => gateModel(trained.model as TrainedModel));
    }
  }
});

test("ROB-12 — variable parfaitement prédictive en 1e-300 : la logistique doit la voir", { todo: "ROB-12 : l'écart-type sous-déborde (train.ts:254) et l'échelle retombe à 1" }, () => {
  for (const name of ["1e-300 / 0", "1e-310 (sous-normal) / 0"]) {
    const trained = train(CASES[name], LOGISTIC);
    assert.equal(trained.kind, "trained");
    if (trained.kind === "trained") {
      console.log(`[ROB-12] ${name} : ${JSON.stringify(trained.model.metrics)}`);
      assert.ok((trained.model.metrics as { accuracy: number }).accuracy > 0.99, `${name} : accuracy ${(trained.model.metrics as { accuracy: number }).accuracy}`);
    }
  }
});
