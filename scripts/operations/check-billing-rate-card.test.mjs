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
// Format réel de `vercel pull` (vercel@59) : seuls `\n` et `\r` sont échappés, guillemets et
// barres obliques inverses restent bruts.
const envLine = (key, value) => `${key}="${value.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
const envFile = (vars) => `# Created by Vercel CLI\n${Object.entries(vars).map(([k, v]) => envLine(k, v)).join("\n")}\n`;

test("relit le JSON tel que l'écrit vercel pull, guillemets non échappés", () => {
  const json = JSON.stringify(policy({ note: "a \"b\" \\ c" }));
  assert.equal(parseEnvFile(envFile({ SIRIUS_BILLING_POLICY_JSON: json })).SIRIUS_BILLING_POLICY_JSON, json);
  assert.equal(parseEnvFile("MULTI=\"l1\\nl2\"\n").MULTI, "l1\nl2");
  assert.deepEqual(parseEnvFile("A=plain # commentaire\nB='x\"y'\n"), { A: "plain", B: "x\"y" });
});

test("ligne réelle d'un fichier vercel pull : tarif v7 complet accepté", () => {
  const line = 'SIRIUS_BILLING_POLICY_JSON="{"version":1,"tariffVersion":"demo-trees-api","profiles":{"linear_regression":{},"logistic_regression":{},"gradient_boosted_trees":{}},"apiCallsPerDay":{"logistic_regression":50,"gradient_boosted_trees":100},"apiAccessDailyComputeAmount":"100000"}"';
  const env = parseEnvFile(`# Created by Vercel CLI\nSIRIUS_BILLING_VERSION="7"\n${line}\nSIRIUS_PHALA_DEMO="false"\n`);
  assert.deepEqual(checkRateCard(env), { applies: true, problems: [] });
});

test("variable Sensitive ([SENSITIVE]) lue par la porte : refus en la nommant", () => {
  const S = "[SENSITIVE]";
  const full = JSON.stringify(policy());
  const cases = [
    ["SIRIUS_BILLING_VERSION", { SIRIUS_BILLING_VERSION: S, SIRIUS_BILLING_POLICY_JSON: full }],
    ["SIRIUS_PHALA_DEMO", { SIRIUS_BILLING_VERSION: "7", SIRIUS_PHALA_DEMO: S, SIRIUS_BILLING_POLICY_JSON: full }],
    ["SIRIUS_BILLING_POLICY_JSON", { SIRIUS_BILLING_VERSION: "7", SIRIUS_PHALA_DEMO: "false", SIRIUS_BILLING_POLICY_JSON: S }],
  ];
  for (const [key, env] of cases) {
    const r = checkRateCard(env);
    assert.equal(r.applies, true);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], new RegExp(`^${key} est marquée Sensitive`));
  }
});

test("cibles v6 et démonstration : variables Sensitive inutilisées sans effet", () => {
  const S = "[SENSITIVE]";
  assert.equal(checkRateCard({ SIRIUS_BILLING_VERSION: "6", SIRIUS_BILLING_POLICY_JSON: S, SIRIUS_PHALA_DEMO: S }).applies, false);
  assert.equal(checkRateCard({ SIRIUS_BILLING_POLICY_JSON: S }).applies, false);
  assert.equal(checkRateCard({ SIRIUS_BILLING_VERSION: "7", SIRIUS_PHALA_DEMO: "true", SIRIUS_BILLING_POLICY_JSON: S }).applies, false);
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
