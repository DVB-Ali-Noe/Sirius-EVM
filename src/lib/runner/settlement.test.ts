import assert from "node:assert/strict";
import { test } from "node:test";
import type { TransactionMetadata } from "xrpl";
import {
  assertResolutionScanBudget,
  escrowResolutionFromEntry,
  MAX_RESOLUTION_PAGES,
} from "./settlement";

const scope = {
  borrower: "rBorrower",
  escrowSequence: 7,
  conditionHex: "A".repeat(64),
};
const success = { TransactionResult: "tesSUCCESS" } as TransactionMetadata;

test("la réconciliation distingue un EscrowFinish d’un remboursement", () => {
  assert.deepEqual(
    escrowResolutionFromEntry({
      hash: "B".repeat(64),
      meta: success,
      tx: {
        TransactionType: "EscrowFinish",
        Owner: scope.borrower,
        OfferSequence: scope.escrowSequence,
        Condition: scope.conditionHex,
      },
    }, scope),
    { state: "settled", txHash: "B".repeat(64) },
  );
  assert.deepEqual(
    escrowResolutionFromEntry({
      hash: "C".repeat(64),
      meta: success,
      tx: {
        TransactionType: "EscrowCancel",
        Owner: scope.borrower,
        OfferSequence: scope.escrowSequence,
      },
    }, scope),
    { state: "cancelled", txHash: "C".repeat(64) },
  );
});

test("une transaction échouée ou hors scope ne clôture jamais le prêt", () => {
  assert.equal(
    escrowResolutionFromEntry({
      hash: "D".repeat(64),
      meta: { TransactionResult: "tecNO_PERMISSION" } as TransactionMetadata,
      tx: {
        TransactionType: "EscrowCancel",
        Owner: scope.borrower,
        OfferSequence: scope.escrowSequence,
      },
    }, scope),
    null,
  );
  assert.equal(
    escrowResolutionFromEntry({
      hash: "E".repeat(64),
      meta: success,
      tx: {
        TransactionType: "EscrowFinish",
        Owner: "rOther",
        OfferSequence: scope.escrowSequence,
        Condition: scope.conditionHex,
      },
    }, scope),
    null,
  );
});

test("la réconciliation XRPL échoue fermée au-delà du budget synchrone", () => {
  assert.doesNotThrow(() => assertResolutionScanBudget(MAX_RESOLUTION_PAGES - 1, true));
  assert.doesNotThrow(() => assertResolutionScanBudget(MAX_RESOLUTION_PAGES, false));
  assert.throws(
    () => assertResolutionScanBudget(MAX_RESOLUTION_PAGES, true),
    /Historique XRPL trop volumineux/,
  );
});
