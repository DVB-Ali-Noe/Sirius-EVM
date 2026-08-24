import assert from "node:assert/strict";
import test from "node:test";
import type { CredentialAccept } from "xrpl";
import { assertKybAcceptScope, KYB_TYPE_HEX } from "./credentials";

const subject = "rSubject";
const issuer = "rIssuer";
const transaction: CredentialAccept = {
  TransactionType: "CredentialAccept",
  Account: subject,
  Issuer: issuer,
  CredentialType: KYB_TYPE_HEX,
  Sequence: 12,
  LastLedgerSequence: 100,
  Fee: "12",
};

test("le CredentialAccept reste signé par le sujet et borné au KYB Sirius", () => {
  assert.doesNotThrow(() => assertKybAcceptScope(transaction, subject, issuer));
  assert.throws(
    () => assertKybAcceptScope({ ...transaction, Issuer: "rOther" }, subject, issuer),
    /hors scope/,
  );
  assert.throws(
    () => assertKybAcceptScope({ ...transaction, CredentialType: "41444D494E" }, subject, issuer),
    /hors scope/,
  );
  assert.throws(
    () => assertKybAcceptScope({ ...transaction, Memos: [] }, subject, issuer),
    /hors scope/,
  );
});
