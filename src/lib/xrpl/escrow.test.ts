import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLiveEscrowScope, type LiveEscrow } from "./escrow";

const nowRippleTime = 800_000_000;

const scope = {
  owner: "rBorrower",
  destination: "rProvider",
  amountDrops: "10000000",
  conditionHex: "A".repeat(64),
  cancelAfter: nowRippleTime + 1_200,
  nowRippleTime,
};

const escrow: LiveEscrow = {
  LedgerEntryType: "Escrow",
  Account: scope.owner,
  Destination: scope.destination,
  Amount: scope.amountDrops,
  Condition: scope.conditionHex,
  CancelAfter: scope.cancelAfter,
};

test("l'escrow doit encore exister et correspondre au prêt", () => {
  assert.doesNotThrow(() => assertLiveEscrowScope(escrow, scope));
  assert.throws(() => assertLiveEscrowScope(null, scope), /inactif/);
  assert.throws(() => assertLiveEscrowScope({ ...escrow, Amount: "1000" }, scope), /hors scope/);
  assert.throws(() => assertLiveEscrowScope({ ...escrow, CancelAfter: scope.cancelAfter + 1 }, scope), /hors scope/);
});

test("l'escrow conserve une marge suffisante avant CancelAfter", () => {
  assert.doesNotThrow(() => assertLiveEscrowScope(escrow, scope));
  assert.throws(
    () => assertLiveEscrowScope({ ...escrow, CancelAfter: nowRippleTime + 600 }, {
      ...scope,
      cancelAfter: nowRippleTime + 600,
    }),
    /trop proche/,
  );
});
