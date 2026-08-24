import assert from "node:assert/strict";
import { test } from "node:test";
import { priceXrpToDrops } from "./amount";

test("le prix provider est normalisé en drops sans arrondi", () => {
  assert.equal(priceXrpToDrops("0.001"), "1000");
  assert.equal(priceXrpToDrops("10.25"), "10250000");
  assert.equal(priceXrpToDrops("1000000"), "1000000000000");

  for (const invalid of ["0.000999", "1.0000001", "01", "1e3", "1000000.000001", "abc"]) {
    assert.equal(priceXrpToDrops(invalid), null);
  }
  assert.equal(priceXrpToDrops(10), null);
});
