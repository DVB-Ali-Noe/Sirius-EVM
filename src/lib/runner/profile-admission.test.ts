import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { MODEL_REGISTRY, selectionForModelId } from "@/lib/models/registry";
import { assertLockedProfile, OPT_IN_PROFILE_DISABLED, requestedTrainingProfile } from "./profile-admission";

const trees = selectionForModelId("gradient_boosted_trees");
const quoteFor = (modelId: string, modelVersion: string) => ({ quote: { modelId, modelVersion } });

function withOptIn<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS;
  if (value === undefined) delete process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS;
  else process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS = value;
  try { return run(); } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS;
    else process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS = previous;
  }
}

test("nouvel usage : un profil facultatif coupé est refusé avec un motif lisible, un profil inconnu reste « non autorisé »", () => {
  withOptIn(undefined, () => {
    assert.throws(() => requestedTrainingProfile({ modelId: "gradient_boosted_trees", modelVersion: MODEL_REGISTRY.gradient_boosted_trees.version }),
      { message: OPT_IN_PROFILE_DISABLED, status: 400 });
    assert.throws(() => requestedTrainingProfile({ modelId: "other", modelVersion: "1.0.0" }), { message: "Modèle ou version non autorisé" });
    assert.deepEqual(requestedTrainingProfile({ modelId: "logistic_regression", modelVersion: "1.0.0" }), selectionForModelId("logistic_regression"));
  });
  withOptIn("gradient_boosted_trees", () => {
    assert.deepEqual(requestedTrainingProfile({ modelId: "gradient_boosted_trees", modelVersion: "1.0.0" }), trees);
  });
});

test("PAR-01 : interrupteur coupé après le lock, le prêt payé sous devis signé pour ce profil s'exécute", () => {
  withOptIn(undefined, () => {
    // La lecture de la requête ne bloque plus le prêt verrouillé…
    assert.deepEqual(requestedTrainingProfile({ modelId: "gradient_boosted_trees", modelVersion: "1.0.0" }, "locked"), trees);
    // … le devis signé par l'enclave pour ce profil suffit.
    assert.doesNotThrow(() => assertLockedProfile(trees, quoteFor("gradient_boosted_trees", "1.0.0")));
    // Sans devis (v6) ou avec un devis d'un autre profil : refus, comme avant.
    assert.throws(() => assertLockedProfile(trees, undefined), { message: OPT_IN_PROFILE_DISABLED });
    assert.throws(() => assertLockedProfile(trees, quoteFor("logistic_regression", "1.0.0")), { message: OPT_IN_PROFILE_DISABLED });
    assert.throws(() => assertLockedProfile(trees, quoteFor("gradient_boosted_trees", "9.9.9")), { message: OPT_IN_PROFILE_DISABLED });
    // Les profils standard ne dépendent jamais de l'interrupteur.
    assert.doesNotThrow(() => assertLockedProfile(selectionForModelId("linear_regression"), undefined));
  });
  assert.doesNotThrow(() => assertLockedProfile(trees, undefined, "gradient_boosted_trees"));
});

test("run-loan-job lit le profil en mode « locked » puis le juge après vérification du devis", () => {
  const handler = readFileSync(resolve(process.cwd(), "src/runner/handler.ts"), "utf8");
  const runLoanJob = handler.slice(handler.indexOf('case "run-loan-job": {'), handler.indexOf('case "recover-loan-job": {'));
  assert.match(runLoanJob, /datasetRef\(body, "locked"\)/);
  const quoteCheck = runLoanJob.indexOf("assertQuoteDataset(");
  const profileCheck = runLoanJob.indexOf("assertLockedProfile(dataset, signedQuote)");
  assert.ok(quoteCheck > 0 && profileCheck > quoteCheck, "le profil se juge après le contrôle du devis");
  // Les autres opérations gardent le contrôle strict de l'interrupteur.
  for (const op of ["seal-dataset", "prepare-escrow-lock", "run-training"]) {
    const start = handler.indexOf(`case "${op}": {`);
    const body = handler.slice(start, handler.indexOf("case \"", start + 10));
    assert.doesNotMatch(body, /"locked"/, op);
  }
});
