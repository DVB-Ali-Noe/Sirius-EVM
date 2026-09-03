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
