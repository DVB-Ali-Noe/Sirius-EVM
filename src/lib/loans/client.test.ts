import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "loans", "client.ts"), "utf8");

test("le hash de lock est persisté et soumis immédiatement au serveur", () => {
  const borrow = SOURCE.slice(SOURCE.indexOf("export async function borrowDataset"), SOURCE.indexOf("export async function resumeLoanSubmission"));

  assert.ok(
    borrow.indexOf("window.sessionStorage.setItem") < borrow.indexOf("await submitLoanLock"),
    "un hash déjà signé doit rester récupérable si la confirmation tarde",
  );
  assert.doesNotMatch(borrow, /await waitForTransactionExternal/);
});

test("le règlement reprend après rechargement sans dépendre de la capsule locale", () => {
  const resumption = SOURCE.slice(SOURCE.indexOf("export async function resumeLoanSettlement"));

  assert.doesNotMatch(resumption, /hasAtomicLoanEnvelope|Capsule locale absente/);
  assert.match(resumption, /await settleLoan\(loanId, runnerReceipt\)/);
});
