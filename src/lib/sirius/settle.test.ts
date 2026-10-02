import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "sirius", "settle.ts"), "utf8");

test("une release EVM réconciliée devient SETTLED après une réponse runner perdue", () => {
  const recovery = SOURCE.slice(SOURCE.indexOf("export async function settlePreparedLoan"));

  assert.match(recovery, /resolution\?\.state === "settled"[\s\S]*?status: "SETTLED"[\s\S]*?settleTxHash: resolution\.txHash/);
});

test("le résultat runner est attesté avant sa persistance", () => {
  const preparation = SOURCE.slice(SOURCE.indexOf("export async function prepareLoanResult"));

  assert.match(preparation, /await verifyLoanAttestation\(/);
  assert.match(preparation, /attestationPayload: result\.attestation\.payload/);
  assert.match(preparation, /attestationQuote: result\.attestation\.evidence\?\.quote \?\? null/);
  assert.match(preparation, /auditReceipt: result\.attestation\.signature/);
});

test("le règlement refuse un résultat sans preuve d’attestation", () => {
  const settlement = SOURCE.slice(SOURCE.indexOf("export async function settlePreparedLoan"));

  assert.match(settlement, /!loan\.attestationHash/);
  assert.match(settlement, /!loan\.attestationPayload/);
  assert.match(settlement, /TEE_MODE === "phala"/);
});

test("le règlement reprend avec le hash attesté, pas une capsule navigateur", () => {
  const settlement = SOURCE.slice(SOURCE.indexOf("export async function settlePreparedLoan"));

  assert.match(settlement, /payload\.releaseEnvelopeHash/);
  assert.doesNotMatch(settlement, /releaseEnvelopeHash: string/);
});

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

test("un règlement en attente de finalité reste SETTLING avec son hash, sans réconciliation ni retour arrière", () => {
  const settlement = SOURCE.slice(SOURCE.indexOf("export async function settlePreparedLoan"));
  const pending = settlement.slice(settlement.indexOf("if (error instanceof RunnerFinalityPending)"));

  assert.match(pending, /^if \(error instanceof RunnerFinalityPending\) \{[\s\S]*?status: "SETTLING"[\s\S]*?settleTxHash: error\.transactionHash[\s\S]*?throw error;\s*\}/);
  assert.ok(settlement.indexOf("RunnerFinalityPending") < settlement.indexOf("reconcileLoanEscrow"), "l’attente passe avant toute réconciliation");
});

test("l’entraînement n’est demandé au runner qu’après finalité du lock", () => {
  const preparation = SOURCE.slice(SOURCE.indexOf("export async function prepareLoanResult"));

  assert.ok(preparation.indexOf("assertBlockStable") < preparation.indexOf('status: "TRAINING"'), "garde avant la prise du lease");
  assert.ok(preparation.indexOf("assertBlockStable") < preparation.indexOf("runLoanJobInRunner("));
});

test("l’attente de finalité traverse le runner distant comme en processus", () => {
  const server = read("src", "runner", "server.ts");
  const client = read("src", "lib", "tee", "runner-client.ts");
  const route = read("src", "app", "api", "loans", "[id]", "settle", "route.ts");

  assert.match(server, /err instanceof RunnerFinalityPending[\s\S]*?send\(202, \{ state: "pending-finality", transactionHash: err\.transactionHash/);
  assert.match(client, /response\.status === 202 && body\.state === "pending-finality"[\s\S]*?throw new RunnerFinalityPending/);
  assert.match(client, /!response\.ok \|\| response\.status !== 200/, "aucune autre réponse 2xx n’est prise pour un succès");
  assert.match(route, /err instanceof RunnerFinalityPending[\s\S]*?pending: true[\s\S]*?status: 202/);
});
