import assert from "node:assert/strict";
import { test } from "node:test";
import { formatWeiAsEth, isValidWeiAmount, priceEthToWei } from "./amount";

test("le prix provider est normalisé en wei sans perte de précision", () => {
  assert.equal(priceEthToWei("0.000001"), "1000000000000");
  assert.equal(priceEthToWei("0.25"), "250000000000000000");
  assert.equal(priceEthToWei("1"), "1000000000000000000");
  assert.equal(priceEthToWei("1000"), "1000000000000000000000");

  // La 18ᵉ décimale doit survivre : c'est précisément ce qu'un `number` perdrait.
  // On reste au-dessus du plancher, sinon la borne l'emporte avant la précision.
  assert.equal(priceEthToWei("0.000001000000000001"), "1000000000001");
});

test("le prix provider rejette les saisies malformées ou hors bornes", () => {
  for (const invalid of [
    "0.0000009", // sous le plancher
    "1001", // au-dessus du plafond
    "0.0000000000000000001", // 19 décimales
    "01", // zéro non significatif
    "1e3", // notation scientifique
    "-1",
    "1,5",
    "",
    " ",
    "abc",
  ]) {
    assert.equal(priceEthToWei(invalid), null, `attendu null pour ${JSON.stringify(invalid)}`);
  }
  // Un nombre JavaScript est refusé par construction : la précision se perdrait.
  assert.equal(priceEthToWei(0.25), null);
  assert.equal(priceEthToWei(null), null);
});

test("les montants en wei persistés sont revalidés avant usage", () => {
  assert.equal(isValidWeiAmount("250000000000000000"), true);
  assert.equal(isValidWeiAmount("1000000000000"), true);

  for (const invalid of ["999999999999", "0", "", "12.5", "-1", "0x10", "1".repeat(27)]) {
    assert.equal(isValidWeiAmount(invalid), false, `attendu false pour ${JSON.stringify(invalid)}`);
  }
  assert.equal(isValidWeiAmount(250), false);
});

test("l'affichage des wei ne laisse pas de zéros de fin", () => {
  assert.equal(formatWeiAsEth("1000000000000000000"), "1");
  assert.equal(formatWeiAsEth("250000000000000000"), "0.25");
  assert.equal(formatWeiAsEth("1"), "0.000000000000000001");
  assert.equal(formatWeiAsEth("1000000000000000000000"), "1000");
});
