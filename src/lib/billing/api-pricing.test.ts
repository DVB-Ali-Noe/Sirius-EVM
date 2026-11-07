import assert from "node:assert/strict";
import { test } from "node:test";
import {
  API_SIGNING_PREFIX, CALL_PACK_SIZES, apiCanonicalString, isCallPackSize, packDatasetAmount, pricePerCallAtomic,
} from "./api-pricing";

test("le prix d'un appel est le prix par jour divisé par le quota, arrondi au supérieur", () => {
  assert.equal(pricePerCallAtomic("1000000", 50), "20000");
  assert.equal(pricePerCallAtomic("1000001", 50), "20001");
  assert.equal(pricePerCallAtomic("1", 10_000), "1", "jamais un appel gratuit");
  assert.equal(pricePerCallAtomic("7000000000000000000", 100), "70000000000000000");
  for (const [price, calls] of [["0", 50], ["-1", 50], ["1e6", 50], ["1.5", 50], ["1000000", 0], ["1000000", 10_001], ["1000000", 1.5]] as const) {
    assert.throws(() => pricePerCallAtomic(price, calls), Error, `${price} / ${calls}`);
  }
});

test("un pack vaut taille × prix arrondi d'un appel ; seules les tailles 100, 1 000 et 10 000 existent", () => {
  assert.deepEqual([...CALL_PACK_SIZES], [100, 1000, 10000]);
  // 1 000 001 / 50 = 20 000,02 → 20 001 par appel.
  assert.equal(packDatasetAmount("1000001", 50, 100), "2000100");
  assert.equal(packDatasetAmount("1000001", 50, 1000), "20001000");
  assert.equal(packDatasetAmount("1000001", 50, 10000), "200010000");
  for (const size of [0, 1, 99, 101, 500, 100000, 100.5, Number.NaN]) {
    assert.equal(isCallPackSize(size), false);
    assert.throws(() => packDatasetAmount("1000000", 50, size), /Taille de pack/);
  }
  assert.equal(isCallPackSize("100"), false);
  for (const size of CALL_PACK_SIZES) assert.equal(isCallPackSize(size), true);
});

test("la chaîne signée a un format exact : préfixe, méthode, chemin sans requête, secondes, nonce, empreinte du corps", () => {
  const bodySha256Hex = "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855";
  assert.equal(API_SIGNING_PREFIX, "SIRIUS-HMAC-SHA256");
  assert.equal(
    apiCanonicalString({ method: "post", path: "/v1/models/loan-1/predict?debug=1", timestamp: 1_794_000_000, nonce: "n0nce-AbCdEfGh12", bodySha256Hex }),
    "SIRIUS-HMAC-SHA256\nPOST\n/v1/models/loan-1/predict\n1794000000\nn0nce-AbCdEfGh12\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    apiCanonicalString({ method: "GET", path: "/v1/models/loan-1", timestamp: 0, nonce: "n", bodySha256Hex: "ab" }),
    ["SIRIUS-HMAC-SHA256", "GET", "/v1/models/loan-1", "0", "n", "ab"].join("\n"),
  );
  for (const timestamp of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => apiCanonicalString({ method: "GET", path: "/v1", timestamp, nonce: "n", bodySha256Hex: "ab" }), /horodatage/);
  }
});
