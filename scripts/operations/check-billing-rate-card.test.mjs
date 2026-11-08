import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkRateCard, parseEnvFile } from "./check-billing-rate-card.mjs";

const policy = (overrides = {}) => ({
  version: 1,
  profiles: { linear_regression: {}, logistic_regression: {}, gradient_boosted_trees: {} },
  apiCallsPerDay: { logistic_regression: 50, gradient_boosted_trees: 100 },
  apiAccessDailyComputeAmount: "100000",
  ...overrides,
});
// Échappement identique à celui de `vercel pull` : guillemets et barres obliques inverses.
const envLine = (key, value) => `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n")}"`;
const envFile = (vars) => `# Created by Vercel CLI\n${Object.entries(vars).map(([k, v]) => envLine(k, v)).join("\n")}\n`;

test("relit le JSON échappé par vercel pull", () => {
  const json = JSON.stringify(policy({ note: "a \"b\" \\ c" }));
  assert.equal(parseEnvFile(envFile({ SIRIUS_BILLING_POLICY_JSON: json })).SIRIUS_BILLING_POLICY_JSON, json);
  assert.deepEqual(parseEnvFile("A=plain # commentaire\nB='x\"y'\n"), { A: "plain", B: "x\"y" });
});

test("v7 complet : déploiement autorisé", () => {
  assert.deepEqual(checkRateCard({ SIRIUS_BILLING_VERSION: "7", SIRIUS_BILLING_POLICY_JSON: JSON.stringify(policy()) }),
    { applies: true, problems: [] });
});

test("v7 sans prix journalier ou sans quota d'un profil louable : refus", () => {
  const noFee = policy();
  delete noFee.apiAccessDailyComputeAmount;
  assert.equal(checkRateCard({ SIRIUS_BILLING_VERSION: "7", SIRIUS_BILLING_POLICY_JSON: JSON.stringify(noFee) }).problems.length, 1);
  const r = checkRateCard({ SIRIUS_BILLING_VERSION: "7", SIRIUS_BILLING_POLICY_JSON: JSON.stringify(policy({ apiCallsPerDay: { logistic_regression: 50 } })) });
  assert.deepEqual(r.problems, ["apiCallsPerDay manquant pour le profil louable gradient_boosted_trees"]);
  assert.equal(checkRateCard({ SIRIUS_BILLING_VERSION: "7" }).problems.length, 1);
  assert.equal(checkRateCard({ SIRIUS_BILLING_VERSION: "7", SIRIUS_BILLING_POLICY_JSON: "{" }).problems.length, 1);
});

test("la régression linéaire n'exige pas de quota API (D-27)", () => {
  assert.deepEqual(checkRateCard({ SIRIUS_BILLING_VERSION: "7", SIRIUS_BILLING_POLICY_JSON: JSON.stringify(policy()) }).problems, []);
});

test("v6 et démonstration Phala : porte sans objet", () => {
  assert.equal(checkRateCard({}).applies, false);
  assert.equal(checkRateCard({ SIRIUS_BILLING_VERSION: "6" }).applies, false);
  assert.equal(checkRateCard({ SIRIUS_BILLING_VERSION: "7", SIRIUS_PHALA_DEMO: "true" }).applies, false);
  assert.equal(checkRateCard({ SIRIUS_BILLING_VERSION: "7", SIRIUS_PHALA_DEMO: "false" }).applies, true);
});

test("la CLI échoue sans jamais afficher de valeur", () => {
  const dir = mkdtempSync(join(tmpdir(), "rate-card-"));
  const file = join(dir, ".env.production.local");
  const secret = "postgresql://user:tres-secret@db/x";
  writeFileSync(file, envFile({ DATABASE_URL: secret, SIRIUS_BILLING_VERSION: "7",
    SIRIUS_BILLING_POLICY_JSON: JSON.stringify(policy({ apiAccessDailyComputeAmount: undefined, costReference: "ref-secrete" })) }));
  const run = spawnSync(process.execPath, [new URL("./check-billing-rate-card.mjs", import.meta.url).pathname, file], { encoding: "utf8" });
  assert.equal(run.status, 1);
  const out = run.stdout + run.stderr;
  assert.match(out, /apiAccessDailyComputeAmount/);
  assert.doesNotMatch(out, /tres-secret|ref-secrete/);
  const missing = spawnSync(process.execPath, [new URL("./check-billing-rate-card.mjs", import.meta.url).pathname, join(dir, "absent")], { encoding: "utf8" });
  assert.equal(missing.status, 1);
});
