import assert from "node:assert/strict";
import { test } from "node:test";
import { r2BrowserOrigin } from "./r2-origin";

test("l'origine R2 ouverte au navigateur est celle du seul compte configuré", () => {
  const account = "0123456789abcdef0123456789abcdef";
  assert.equal(r2BrowserOrigin(account), `https://${account}.r2.cloudflarestorage.com`);
  assert.equal(r2BrowserOrigin(` ${account}\n`), `https://${account}.r2.cloudflarestorage.com`);
});

test("sans compte valide, aucune origine n'est ajoutée", () => {
  for (const value of [undefined, "", "   ", "*", "0123456789ABCDEF0123456789ABCDEF", "abc", "0123456789abcdef0123456789abcdef.evil.com", "x y"]) {
    assert.equal(r2BrowserOrigin(value), null);
  }
});
