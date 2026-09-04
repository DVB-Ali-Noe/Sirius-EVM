import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "loans", "client.ts"), "utf8");

test("le hash de lock est conservé avant l'attente de confirmation wallet", () => {
  const borrow = SOURCE.slice(SOURCE.indexOf("export async function borrowDataset"), SOURCE.indexOf("export async function resumeLoanSubmission"));

  assert.ok(
    borrow.indexOf("window.sessionStorage.setItem") < borrow.indexOf("await waitForTransactionExternal(lockTxHash)"),
    "un hash déjà signé doit rester récupérable si la confirmation tarde",
  );
  assert.ok(
    borrow.indexOf("await waitForTransactionExternal(lockTxHash)") < borrow.indexOf("await submitLoanLock"),
    "l'API ne doit pas finaliser avant le reçu de confirmation",
  );
});

test("le règlement reprend après rechargement sans dépendre de la capsule locale", () => {
  const resumption = SOURCE.slice(SOURCE.indexOf("export async function resumeLoanSettlement"));

  assert.doesNotMatch(resumption, /hasAtomicLoanEnvelope|Capsule locale absente/);
  assert.match(resumption, /await settleLoan\(loanId, runnerReceipt\)/);
});
