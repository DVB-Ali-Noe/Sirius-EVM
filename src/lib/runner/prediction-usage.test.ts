import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { demoSessions, predictionSessionRevision } from "@/lib/phala-demo/runner-session";
import { AppError } from "@/lib/app-error";
import {
  apiAccessPaidUntil, creditCallPack, engageApiAccessPass, hasApiAccessPass, predictionAllowance, recordApiAccessPass, reservePrediction,
} from "./prediction-usage";
import { apiAccessComputeAmount, apiAccessDatasetAmount, apiAccessDaysFor } from "@/lib/billing/api-pricing";
import { DAY_MS } from "@/lib/billing/rental";
import { scopeForRunnerOp } from "@/runner/handler";

const owner = `0x${"ab".repeat(20)}`;
const policy = {
  funding: "credits" as const, creditsUsdMicros: "1000", cashUsdMicros: "0", ceilingUsdMicros: "900",
  maxOperations: 4, maxOperationsPerWallet: 2, maxConcurrent: 1,
};
const job = { kind: "job", id: "model-1" } as const;
const loan = { kind: "loan", id: "model-1" } as const;

function withEnv(values: Record<string, string>, run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "sirius-predict-usage-"));
  const saved = { ...process.env };
  Object.assign(process.env, { RUNNER_PREDICT_USAGE_FILE: join(root, "usage.sqlite"), ...values });
  try {
    run(root);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
}

test("scope runner de predict : job → jobId, prêt → loanId", () => {
  assert.deepEqual(scopeForRunnerOp("predict", { modelRef: job }), { op: "predict", scope: { jobId: "model-1" } });
  assert.deepEqual(scopeForRunnerOp("predict", { modelRef: loan }), { op: "predict", scope: { loanId: "model-1" } });
  assert.throws(() => scopeForRunnerOp("predict", { modelRef: { kind: "dataset", id: "x" } }), /invalide/);
  assert.throws(() => scopeForRunnerOp("predict", { modelRef: { kind: "job", id: "../x" } }), /invalide/);
  for (const op of ["register-api-key", "revoke-api-key", "api-predict", "api-info", "buy-calls"]) {
    assert.deepEqual(scopeForRunnerOp(op, { loanId: "loan-1" }), { op, scope: { loanId: "loan-1" } });
    assert.throws(() => scopeForRunnerOp(op, {}), /loanId invalide/);
  }
});

test("hors démonstration : révision 0, quota par (sujet, modelRef) et non par identifiant nu", () => {
  withEnv({ SIRIUS_PHALA_DEMO: "false", RUNNER_PREDICT_DAILY_LIMIT: "2" }, () => {
    assert.equal(predictionSessionRevision(), 0);
    assert.equal(reservePrediction(owner.toUpperCase().replace(/^0X/, "0x"), job, 0).counter, 1);
    assert.equal(reservePrediction(owner, job, 0).counter, 2);
    assert.throws(() => reservePrediction(owner, job, 0), /Quota quotidien/);
    // Un prêt homonyme a son propre quota et son propre compteur.
    assert.equal(reservePrediction(owner, loan, 0).counter, 1);
    assert.equal(reservePrediction(`0x${"cd".repeat(20)}`, job, 0).counter, 1);
    assert.throws(() => reservePrediction(owner, job, 1), /remplacée/);
    assert.throws(() => reservePrediction(owner, { kind: "job", id: "a:b" }, 0), /Scope de prédiction invalide/);
    assert.equal(statSync(process.env.RUNNER_PREDICT_USAGE_FILE!).mode & 0o777, 0o600);
  });
});

test("démonstration : session ouverte obligatoire, révision liée, quota durable après réouverture", () => {
  withEnv({ EVM_NETWORK: "testnet", TEE_MODE: "phala", DSTACK_SIMULATOR_ENDPOINT: "", SIRIUS_PHALA_DEMO: "true",
    RUNNER_PREDICT_DAILY_LIMIT: "2" }, (root) => {
    process.env.RUNNER_DEMO_SESSION_FILE = join(root, "sessions.sqlite");
    assert.throws(predictionSessionRevision, /fermée/);
    const store = demoSessions();
    store.command("open", 0, owner, policy);
    assert.equal(predictionSessionRevision(), 1);
    assert.equal(reservePrediction(owner, job, 1).counter, 1);
    assert.equal(reservePrediction(owner, job, 1).counter, 2);
    assert.throws(() => reservePrediction(owner, job, 1), /Quota quotidien/);
    store.command("close", 1, owner);
    assert.throws(() => reservePrediction(owner, job, 2), /fermée/);
    store.command("open", 2, owner, policy);
    assert.throws(() => reservePrediction(owner, job, 1), /remplacée/);
    assert.throws(() => reservePrediction(owner, job, 3), /Quota quotidien/);
    process.env.RUNNER_PREDICT_DAILY_LIMIT = "101";
    assert.throws(() => reservePrediction(owner, loan, 3), /Quota quotidien de prédiction invalide/);
    store.close();
  });
});

const quotaExceeded = (error: unknown) => error instanceof AppError && error.status === 429 && error.code === "quota_exceeded";

test("prêt : quota du jour du profil d'abord, puis crédits de packs, refus quand les deux sont vides", () => {
  withEnv({ SIRIUS_PHALA_DEMO: "false", RUNNER_PREDICT_DAILY_LIMIT: "2" }, () => {
    assert.deepEqual(predictionAllowance(owner, loan, 3), { today: 3, credits: 0 });
    assert.deepEqual(reservePrediction(owner, loan, 0, 3), { counter: 1, remaining: { today: 2, credits: 0 } },
      "quota du profil (3), pas RUNNER_PREDICT_DAILY_LIMIT (2)");
    assert.deepEqual(predictionAllowance(owner, loan, 3), { today: 2, credits: 0 }, "lire le solde ne consomme rien");
    assert.deepEqual(predictionAllowance(owner, loan, 3), { today: 2, credits: 0 });
    assert.equal(creditCallPack({ packLoanId: "pack-1", originalLoanId: loan.id, subject: owner, calls: 100 }), 100);
    assert.deepEqual(reservePrediction(owner, loan, 0, 3).remaining, { today: 1, credits: 100 }, "crédits intacts tant que le jour suffit");
    assert.deepEqual(reservePrediction(owner, loan, 0, 3).remaining, { today: 0, credits: 100 });
    assert.deepEqual(reservePrediction(owner, loan, 0, 3), { counter: 4, remaining: { today: 0, credits: 99 } }, "puis un crédit");
    for (let call = 0; call < 99; call++) reservePrediction(owner, loan, 0, 3);
    assert.deepEqual(predictionAllowance(owner, loan, 3), { today: 0, credits: 0 });
    assert.throws(() => reservePrediction(owner, loan, 0, 3), quotaExceeded);
    assert.throws(() => reservePrediction(owner, loan, 0, 3), quotaExceeded, "un refus ne consomme rien et se répète");
    // Un autre emprunteur ou un autre prêt ne puise pas dans ces crédits.
    assert.deepEqual(predictionAllowance(`0x${"cd".repeat(20)}`, loan, 3), { today: 3, credits: 0 });
    assert.deepEqual(predictionAllowance(owner, { kind: "loan", id: "model-2" }, 3), { today: 3, credits: 0 });
    // Les self-trains n'ont pas de crédits.
    assert.deepEqual(predictionAllowance(owner, job), { today: 2, credits: 0 });
    assert.throws(() => reservePrediction(owner, loan, 0, 10_001), /Quota quotidien de prédiction invalide/);
  });
});

test("pack d'appels crédité une seule fois, rejeu idempotent, pack d'un autre prêt refusé", () => {
  withEnv({ SIRIUS_PHALA_DEMO: "false" }, () => {
    assert.equal(creditCallPack({ packLoanId: "pack-1", originalLoanId: loan.id, subject: owner, calls: 1_000 }), 1_000);
    assert.equal(creditCallPack({ packLoanId: "pack-1", originalLoanId: loan.id, subject: owner, calls: 1_000 }), 1_000, "rejeu : aucun second crédit");
    assert.equal(creditCallPack({ packLoanId: "pack-2", originalLoanId: loan.id, subject: owner, calls: 100 }), 1_100, "packs cumulables");
    assert.throws(() => creditCallPack({ packLoanId: "pack-1", originalLoanId: "model-2", subject: owner, calls: 1_000 }), /hors scope/);
    assert.throws(() => creditCallPack({ packLoanId: "pack-1", originalLoanId: loan.id, subject: `0x${"cd".repeat(20)}`, calls: 1_000 }), /hors scope/);
    assert.throws(() => creditCallPack({ packLoanId: "pack-1", originalLoanId: loan.id, subject: owner, calls: 100 }), /hors scope/);
    assert.throws(() => creditCallPack({ packLoanId: loan.id, originalLoanId: loan.id, subject: owner, calls: 100 }), /Identifiant de pack invalide/);
    assert.throws(() => creditCallPack({ packLoanId: "pack-3", originalLoanId: loan.id, subject: owner, calls: 0 }), /Taille de pack invalide/);
    assert.deepEqual(predictionAllowance(owner, loan, 50), { today: 50, credits: 1_100 });
  });
});

test("pass d'accès API : jours à payer jusqu'à l'échéance, jour entamé compté, complément après prolongation", () => {
  const now = 1_000 * DAY_MS;
  assert.equal(apiAccessDaysFor(now + 2.5 * DAY_MS, null, now), 3, "jour entamé compté");
  assert.equal(apiAccessDaysFor(now + 3 * DAY_MS, null, now), 3);
  assert.equal(apiAccessDaysFor(now + 3 * DAY_MS, now - DAY_MS, now), 3, "couverture passée : départ maintenant");
  assert.equal(apiAccessDaysFor(now + 6 * DAY_MS, now + 3 * DAY_MS, now), 3, "après prolongation : seulement les jours ajoutés");
  assert.equal(apiAccessDaysFor(now + 3 * DAY_MS, now + 3 * DAY_MS, now), 0, "déjà couverte");
  assert.equal(apiAccessDaysFor(now - 1, null, now), 0, "location échue");
  assert.equal(apiAccessComputeAmount("1500000", 3), "4500000");
  assert.equal(apiAccessDatasetAmount(6), "1000");
  assert.equal(apiAccessDatasetAmount(18), "1000000000000000");
  assert.throws(() => apiAccessComputeAmount("1500000", 0));
});

test("pass d'accès API : journal idempotent par pass, couverture plafonnée à l'échéance, conservée après réouverture", () => {
  withEnv({}, (root) => {
    const released = 2_000 * DAY_MS;
    const rentalEnd = released + 2.5 * DAY_MS;
    assert.equal(apiAccessPaidUntil(owner, "model-1"), null);
    const pass = { passLoanId: "pass-1", originalLoanId: "model-1", subject: owner, days: 3, releasedAt: released, rentalExpiresAt: rentalEnd };
    assert.equal(recordApiAccessPass(pass), rentalEnd, "jamais au-delà de l'échéance");
    assert.equal(recordApiAccessPass({ ...pass, releasedAt: released + DAY_MS, rentalExpiresAt: rentalEnd + 9 * DAY_MS }), rentalEnd,
      "rejoué : enregistré une seule fois");
    assert.throws(() => recordApiAccessPass({ ...pass, days: 4 }), /hors scope/);
    assert.throws(() => recordApiAccessPass({ ...pass, originalLoanId: "other" }), /hors scope/);
    // Prolongation de 3 jours puis complément : la couverture repart de l'ancienne fin.
    const extendedEnd = rentalEnd + 3 * DAY_MS;
    assert.equal(recordApiAccessPass({ ...pass, passLoanId: "pass-2", releasedAt: released + DAY_MS, rentalExpiresAt: extendedEnd }), extendedEnd);
    assert.equal(apiAccessPaidUntil(owner, "model-1"), extendedEnd);
    assert.equal(apiAccessPaidUntil(`0x${"cd".repeat(20)}`, "model-1"), null, "propre à l'emprunteur");
    // Volume relu par un autre processus (copie du registre) : rien n'est perdu.
    const copy = join(root, "reloaded.sqlite");
    copyFileSync(process.env.RUNNER_PREDICT_USAGE_FILE!, copy);
    chmodSync(copy, 0o600);
    process.env.RUNNER_PREDICT_USAGE_FILE = copy;
    assert.equal(apiAccessPaidUntil(owner, "model-1"), extendedEnd);
    assert.equal(recordApiAccessPass(pass), extendedEnd, "rejeu après réouverture : rien de plus");
  });
});

test("pass d'accès API engagé : un seul par base, persistant, repris si sa release n'est pas vivante, effacé à l'enregistrement", () => {
  withEnv({}, (root) => {
    const live = new Set<string>();
    const stale = (error: unknown) => error instanceof AppError && error.status === 409 && error.code === "api_access_stale";
    const engage = (passLoanId: string, coveredUntil: number | null = null) => engageApiAccessPass({
      passLoanId, originalLoanId: "model-1", subject: owner, coveredUntil, release: { id: `release:${passLoanId}`, fingerprint: "0xab" },
      isLive: (engaged) => live.has(engaged),
    });
    engage("pass-a");
    engage("pass-a");
    live.add("pass-a");
    assert.throws(() => engage("pass-b"), stale, "autre pass engagé, release vivante");
    assert.throws(() => engage("pass-a", 1), stale, "couverture différente du devis");
    // Redémarrage : registre relu depuis le disque, marqueur toujours là.
    const copy = join(root, "restarted.sqlite");
    copyFileSync(process.env.RUNNER_PREDICT_USAGE_FILE!, copy);
    chmodSync(copy, 0o600);
    process.env.RUNNER_PREDICT_USAGE_FILE = copy;
    assert.throws(() => engage("pass-b"), stale, "marqueur conservé après redémarrage");
    // Release du premier jamais engagée ou définitivement échouée : le marqueur ne bloque pas.
    live.delete("pass-a");
    engage("pass-b");
    live.add("pass-b");
    assert.throws(() => engage("pass-a"), stale, "le marqueur a changé de pass");
    const coverage = recordApiAccessPass({ passLoanId: "pass-b", originalLoanId: "model-1", subject: owner, days: 1,
      releasedAt: 3_000 * DAY_MS, rentalExpiresAt: 3_001 * DAY_MS });
    assert.throws(() => engage("pass-c"), stale, "couverture changée depuis le devis");
    engage("pass-c", coverage);
  });
});

test("API incluse : couverture au règlement de l'emprunt (clé : le prêt), prolongée par une prolongation incluse, idempotente et conservée", () => {
  withEnv({}, (root) => {
    const released = 4_000 * DAY_MS;
    const rentalEnd = released + 7 * DAY_MS;
    assert.equal(hasApiAccessPass("model-1"), false);
    const rental = { passLoanId: "model-1", originalLoanId: "model-1", subject: owner, days: 7, releasedAt: released, rentalExpiresAt: rentalEnd };
    assert.equal(recordApiAccessPass(rental), rentalEnd);
    assert.equal(hasApiAccessPass("model-1"), true);
    assert.equal(recordApiAccessPass({ ...rental, releasedAt: released + DAY_MS, rentalExpiresAt: rentalEnd + DAY_MS }), rentalEnd, "rejoué : inchangé");
    // Prolongation de 2 jours, API incluse, réglée avant l'échéance : la couverture suit la nouvelle échéance.
    const extendedEnd = rentalEnd + 2 * DAY_MS;
    const extension = { passLoanId: "ext-1", originalLoanId: "model-1", subject: owner, days: 2, releasedAt: rentalEnd - DAY_MS, rentalExpiresAt: extendedEnd };
    assert.equal(recordApiAccessPass(extension), extendedEnd);
    const copy = join(root, "reloaded.sqlite");
    copyFileSync(process.env.RUNNER_PREDICT_USAGE_FILE!, copy);
    chmodSync(copy, 0o600);
    process.env.RUNNER_PREDICT_USAGE_FILE = copy;
    assert.equal(apiAccessPaidUntil(owner, "model-1"), extendedEnd, "conservée après réouverture");
    assert.equal(recordApiAccessPass(extension), extendedEnd);
  });
});
