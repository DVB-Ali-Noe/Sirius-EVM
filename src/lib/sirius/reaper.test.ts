import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "sirius", "reaper.ts"), "utf8");

test("le reaper réconcilie une soumission de lock confirmée", () => {
  assert.match(SOURCE, /status: "SUBMITTING", updatedAt:/);
  assert.match(SOURCE, /getTransactionReceipt\(\{ hash: loan\.evmLockTxHash/);
  assert.match(SOURCE, /await finalizeLoan\(loan\.id, loan\.borrower\)/);
});

test("un reçu introuvable ne transforme jamais un lock signé en annulation locale", () => {
  const submitting = SOURCE.slice(
    SOURCE.indexOf('if (loan.status === "SUBMITTING")'),
    SOURCE.indexOf('if (loan.status === "TRAINING"'),
  );

  assert.doesNotMatch(submitting, /catch \{[\s\S]*?status: "CANCELLED"/);
});
