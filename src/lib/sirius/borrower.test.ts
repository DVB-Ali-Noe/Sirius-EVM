import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "sirius", "borrower.ts"), "utf8");

test("la confirmation du lock précède les lectures EVM", () => {
  const finalize = SOURCE.slice(SOURCE.indexOf("export async function finalizeLoan"));
  const submission = finalize.indexOf('data: { status: "SUBMITTING", evmLockTxHash: submittedLockTxHash }');
  const confirmation = finalize.indexOf("await publicClient.waitForTransactionReceipt");
  const reads = finalize.indexOf("const [transaction, onChain] = await Promise.all");

  assert.ok(submission >= 0, "le hash doit être persisté avec le statut SUBMITTING");
  assert.ok(confirmation >= 0, "le lock doit être confirmé");
  assert.ok(reads >= 0, "les lectures EVM doivent rester parallèles après confirmation");
  assert.ok(submission < confirmation, "une coupure RPC ne doit pas perdre le hash déjà signé");
  assert.ok(confirmation < reads, "getTransaction et readLoan ne doivent pas précéder la confirmation du lock");
});

test("un prêt annulé sans remboursement on-chain reste récupérable", () => {
  const finalize = SOURCE.slice(SOURCE.indexOf("export async function finalizeLoan"));

  assert.match(finalize, /const recoverableCancellation = loan\.status === "CANCELLED" && !loan\.cancelTxHash/);
  assert.match(finalize, /status: \{ in: \["PENDING", "SUBMITTING", "CANCELLED"\] \},\r?\n      cancelTxHash: null/);
});

test("les essais annulés ne consomment pas le quota d’emprunts", () => {
  const prepare = SOURCE.slice(SOURCE.indexOf("export async function prepareLoan"), SOURCE.indexOf("export async function finalizeLoan"));

  assert.match(prepare, /status: \{ in: \["ESCROWED", "TRAINING", "SETTLING", "SETTLED"\] \}/);
});

test("le lock doit porter le titre EVM du dataset demandé", () => {
  const finalize = SOURCE.slice(SOURCE.indexOf("export async function finalizeLoan"));

  assert.match(finalize, /onChain\.datasetId\.toLowerCase\(\) !== loan\.dataset\.evmDatasetId\.toLowerCase\(\)/);
});
