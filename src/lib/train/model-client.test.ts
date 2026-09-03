import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { encrypt } from "@/lib/crypto/encryption";
import { decryptModelPayload } from "./model-client";

const model = {
  algo: "linear_regression" as const,
  version: "1.0.0" as const,
  target: "price",
  features: ["surface", "rooms"],
  coefficients: [12.5, 1.75, -3],
  metrics: { r2: 0.97, rmse: 1234.5, mae: 950.25, n: 140 },
};

test("déchiffre le modèle livré et conserve ses métriques", async () => {
  const key = randomBytes(32);
  const payload = encrypt(Buffer.from(JSON.stringify(model)), key);

  assert.deepEqual(await decryptModelPayload(payload, key.toString("base64")), model);
});

test("déchiffre un modèle logistique avec ses métriques binaires", async () => {
  const key = randomBytes(32);
  const logistic = {
    algo: "logistic_regression" as const,
    version: "1.0.0" as const,
    target: "defaulted",
    features: ["income"],
    coefficients: [-2, 0.4],
    metrics: { accuracy: 0.91, precision: 0.88, recall: 0.83, f1: 0.85, n: 140 },
  };
  const payload = encrypt(Buffer.from(JSON.stringify(logistic)), key);

  assert.deepEqual(await decryptModelPayload(payload, key.toString("base64")), logistic);
});

test("refuse une clé de livraison qui ne correspond pas au modèle", async () => {
  const key = randomBytes(32);
  const payload = encrypt(Buffer.from(JSON.stringify(model)), key);

  await assert.rejects(
    decryptModelPayload(payload, randomBytes(32).toString("base64")),
    /Déchiffrement du modèle impossible/,
  );
});
