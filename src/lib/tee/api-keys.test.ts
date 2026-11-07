import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AppError } from "@/lib/app-error";
import type { LogisticRegressionModel } from "@/lib/models/registry";
import { apiKeyEnvelopeSha256, encryptApiKeySecretForRunner, encryptDatasetForRunner } from "./ingress-client";
import { apiKeyEnvelopeDigest, datasetIngressPublicKey, decryptApiKeySecret } from "./ingress";
import { loadApiKey, registerApiKey, revokeApiKey } from "./api-keys";
import { deleteServedModel, saveServedModel } from "./served-models";

const owner = `0x${"12".repeat(20)}`;
const stranger = `0x${"34".repeat(20)}`;
const logistic: LogisticRegressionModel = {
  algo: "logistic_regression", version: "1.0.0", target: "default", features: ["x"], coefficients: [0, 1],
  metrics: { accuracy: 0.7, precision: 0.7, recall: 0.7, f1: 0.7, n: 100 },
};

function withVolume(run: (directory: string) => Promise<void> | void) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "sirius-api-keys-"));
    const saved = { ...process.env };
    Object.assign(process.env, {
      TEE_MODE: "stub", SIRIUS_MASTER_KEY: Buffer.alloc(32, 29).toString("base64"), RUNNER_SERVED_MODELS_DIR: join(root, "private"),
    });
    try {
      await run(join(root, "private"));
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const code = (expected: string, status: number) => (error: unknown) =>
  error instanceof AppError && error.code === expected && error.status === status;

test("le secret d'une clé API est chiffré pour l'enclave et lié à son identifiant", withVolume(async () => {
  const keyId = randomBytes(16).toString("base64url");
  const secret = randomBytes(32);
  const envelope = await encryptApiKeySecretForRunner(secret.toString("base64url"), keyId, datasetIngressPublicKey());
  assert.equal(JSON.stringify(envelope).includes(secret.toString("base64url")), false);
  assert.deepEqual(decryptApiKeySecret(keyId, envelope), secret);
  assert.throws(() => decryptApiKeySecret(randomBytes(16).toString("base64url"), envelope), /Enveloppe de clé API invalide/);
  const last = envelope.ciphertext.at(-1);
  assert.throws(() => decryptApiKeySecret(keyId, { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -1)}${last === "A" ? "B" : "A"}` }),
    /Enveloppe de clé API invalide/);
  assert.throws(() => decryptApiKeySecret(keyId, { ...envelope, extra: "x" } as never), /incompatible/);
  // Une enveloppe de dataset (autre domaine HKDF) n'ouvre jamais un secret de clé, même à identifiant égal.
  const datasetEnvelope = await encryptDatasetForRunner(new Uint8Array(secret).buffer, keyId, datasetIngressPublicKey());
  assert.throws(() => decryptApiKeySecret(keyId, datasetEnvelope), /Enveloppe de clé API invalide/);
  await assert.rejects(encryptApiKeySecretForRunner("court", keyId, datasetIngressPublicKey()), /Secret de clé API invalide/);
  // Empreinte signée dans le grant : même calcul dans le navigateur et dans l'enclave, ordre des clés compris.
  const reordered = { ciphertext: envelope.ciphertext, iv: envelope.iv, salt: envelope.salt,
    ephemeralPublicKey: envelope.ephemeralPublicKey, version: envelope.version };
  assert.equal(await apiKeyEnvelopeSha256(envelope), apiKeyEnvelopeDigest(envelope));
  assert.equal(apiKeyEnvelopeDigest(reordered), apiKeyEnvelopeDigest(envelope));
  assert.match(apiKeyEnvelopeDigest(envelope), /^[0-9a-f]{64}$/);
}));

test("registre scellé : idempotent, cinq clés actives au plus, révocation idempotente, secret jamais en clair", withVolume((directory) => {
  const loanId = "loan-keys";
  const secrets = Array.from({ length: 7 }, () => randomBytes(32));
  const ids = Array.from({ length: 7 }, () => randomBytes(16).toString("base64url"));
  const first = registerApiKey({ loanId, keyId: ids[0], owner, secret: secrets[0], now: 1_000 });
  assert.deepEqual(first, { keyId: ids[0], createdAt: 1_000 }, "ni secret ni propriétaire dans la réponse");
  assert.deepEqual(registerApiKey({ loanId, keyId: ids[0], owner: owner.toUpperCase().replace(/^0X/, "0x"), secret: secrets[0], now: 2_000 }), first,
    "même identifiant, même secret : même réponse");
  assert.throws(() => registerApiKey({ loanId, keyId: ids[0], owner, secret: secrets[1] }), code("key_conflict", 409));
  assert.throws(() => registerApiKey({ loanId, keyId: ids[0], owner: stranger, secret: secrets[0] }), code("key_conflict", 409));

  const [file] = readdirSync(directory).filter((name) => name.endsWith(".keys"));
  assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600);
  const sealed = readFileSync(join(directory, file), "utf8");
  for (const value of [secrets[0].toString("base64url"), secrets[0].toString("hex"), secrets[0].toString("base64"), ids[0], owner]) {
    assert.equal(sealed.includes(value), false, "fichier chiffré : ni secret, ni identifiant, ni propriétaire");
  }

  for (let index = 1; index < 5; index++) registerApiKey({ loanId, keyId: ids[index], owner, secret: secrets[index] });
  assert.throws(() => registerApiKey({ loanId, keyId: ids[5], owner, secret: secrets[5] }), code("key_limit_reached", 409));
  assert.throws(() => revokeApiKey({ loanId, keyId: ids[1], owner: stranger }), /réservée à l’emprunteur/);
  const revoked = revokeApiKey({ loanId, keyId: ids[1], owner, now: 5_000 });
  assert.deepEqual(revoked, { keyId: ids[1], revokedAt: 5_000 });
  assert.deepEqual(revokeApiKey({ loanId, keyId: ids[1], owner, now: 9_000 }), revoked, "révocation rejouée : même date");
  assert.throws(() => registerApiKey({ loanId, keyId: ids[1], owner, secret: secrets[1] }), code("key_revoked", 409), "une clé révoquée ne revit pas");
  assert.equal(registerApiKey({ loanId, keyId: ids[5], owner, secret: secrets[5] }).keyId, ids[5], "une révocation libère une place");
  assert.throws(() => revokeApiKey({ loanId, keyId: ids[6], owner }), code("unknown_key", 404));

  const material = loadApiKey(loanId, ids[0])!;
  assert.deepEqual([material.loanId, material.owner, material.createdAt, material.revokedAt], [loanId, owner, 1_000, undefined]);
  assert.deepEqual(material.secret, secrets[0]);
  assert.equal(loadApiKey(loanId, ids[1])!.revokedAt, 5_000);
  assert.equal(loadApiKey("loan-other", ids[0]), null, "une clé n'appartient qu'à son prêt");
  assert.equal(loadApiKey(loanId, "not-a-key-id"), null);
  assert.throws(() => registerApiKey({ loanId: "../x", keyId: ids[6], owner, secret: secrets[6] }), /Identifiant de prêt invalide/);
  assert.throws(() => registerApiKey({ loanId, keyId: ids[6], owner, secret: secrets[6].subarray(0, 16) }), /Secret de clé API invalide/);

  // La purge de la location supprime aussi ses clés.
  saveServedModel({ kind: "loan", id: loanId }, owner, logistic);
  deleteServedModel({ kind: "loan", id: loanId });
  assert.equal(loadApiKey(loanId, ids[0]), null);
  assert.deepEqual(readdirSync(directory), []);
}));
