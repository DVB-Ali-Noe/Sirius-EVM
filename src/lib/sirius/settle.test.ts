import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "sirius", "settle.ts"), "utf8");

test("une release EVM réconciliée devient SETTLED après une réponse runner perdue", () => {
  const recovery = SOURCE.slice(SOURCE.indexOf("export async function settlePreparedLoan"));

  assert.match(recovery, /resolution\?\.state === "settled"[\s\S]*?status: "SETTLED"[\s\S]*?settleTxHash: resolution\.txHash/);
});
