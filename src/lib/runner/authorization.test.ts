import assert from "node:assert/strict";
import { before, test } from "node:test";
import { deriveAddress, deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { useWalletStore } from "@/stores/wallet";
import {
  activateRunnerDelegation,
  beginRunnerDelegation,
  issueRunnerGrant,
} from "./authorization-client";
import {
  buildDelegationMessage,
  encodeRunnerGrantHeader,
  parseRunnerGrantHeader,
} from "./authorization-contract";
import { verifyRunnerGrant } from "./authorization";
import {
  assertLoanReleaseEnvelopeHash,
  issueDatasetReceipt,
  issueLoanReceipt,
  verifyDatasetReceipt,
  verifyLoanReceipt,
} from "./receipt";
import { assertEscrowCreateScope, assertEscrowFinishScope } from "./xrpl-proof";
import { escrowConditionPublic, loanModelKey, selfTrainModelKey } from "@/lib/tee/core";
import { createRunnerDelivery, createRunnerReleaseDelivery } from "./delivery-client";
import { encryptRunnerDelivery, encryptRunnerRelease } from "./delivery";

before(() => {
  process.env.TEE_MODE = "stub";
  process.env.SIRIUS_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.XRPL_NETWORK = "testnet";
  process.env.SIRIUS_APP_ORIGIN = "http://localhost:3000";
});

async function signedGrant() {
  const keypair = deriveKeypair(generateSeed());
  const address = deriveAddress(keypair.publicKey);
  useWalletStore.getState().setConnected(address, "testnet", "embedded");

  const sessionPublicKey = await beginRunnerDelegation();
  const now = Date.now();
  const message = buildDelegationMessage({
    origin: "http://localhost:3000",
    address,
    sessionPublicKey,
    network: "testnet",
    issuedAt: now,
    expiresAt: now + 60_000,
    challengeToken: "challenge.signature",
  });
  activateRunnerDelegation({
    message,
    walletPublicKey: keypair.publicKey,
    walletSignature: sign(Buffer.from(message).toString("hex"), keypair.privateKey),
    sessionPublicKey,
  });

  const intentParts = ["dataset-1", "job-1", "receipt-1"];
  const grant = await issueRunnerGrant(
    "run-training",
    { datasetId: "dataset-1", jobId: "job-1" },
    intentParts,
  );
  return { address, grant, intentParts };
}

test("le runner vérifie la chaîne wallet → session → action", async () => {
  const { address, grant, intentParts } = await signedGrant();
  assert.deepEqual(parseRunnerGrantHeader(encodeRunnerGrantHeader(grant)), grant);
  const verified = verifyRunnerGrant(grant, {
    operation: "run-training",
    datasetId: "dataset-1",
    jobId: "job-1",
    intentParts,
  });
  assert.equal(verified.subject, address);
});

test("un grant ne peut pas être élargi ni rejoué", async () => {
  const first = await signedGrant();
  assert.throws(
    () =>
      verifyRunnerGrant(first.grant, {
        operation: "run-training",
        datasetId: "dataset-2",
        jobId: "job-1",
        intentParts: first.intentParts,
      }),
    /hors scope/,
  );

  const second = await signedGrant();
  const expected = {
    operation: "run-training" as const,
    datasetId: "dataset-1",
    jobId: "job-1",
    intentParts: second.intentParts,
  };
  verifyRunnerGrant(second.grant, expected);
  assert.throws(() => verifyRunnerGrant(second.grant, expected), /déjà utilisé/);
});

test("le reçu enclave lie le dataset à son propriétaire et à son ciphertext", () => {
  const dataset = {
    datasetId: "dataset-1",
    cid: "bafy-dataset",
    wrappedKey: "wrapped-key",
    merkleRoot: "abc123",
    priceDrops: "10000000",
    challengeDays: 7,
  };
  const receipt = issueDatasetReceipt("rOwner", dataset);

  assert.equal(verifyDatasetReceipt(receipt, dataset).owner, "rOwner");
  assert.throws(
    () => verifyDatasetReceipt(receipt, { ...dataset, wrappedKey: "other-key" }),
    /hors scope/,
  );
  assert.throws(
    () => verifyDatasetReceipt(receipt, { ...dataset, priceDrops: "1000" }),
    /hors scope/,
  );
});

test("le reçu d’emprunt lie la capsule persistée avant règlement", () => {
  const releaseEnvelopeHash = "a".repeat(64);
  const token = issueLoanReceipt({
    loanId: "loan-1",
    datasetId: "dataset-1",
    borrower: "rBorrower",
    provider: "rProvider",
    modelCid: "bafy-model",
    escrowTxHash: "b".repeat(64),
    escrowSequence: 7,
    deliveryPublicKey: "delivery-key",
    amountDrops: "10000000",
    challengeDays: 7,
    releaseEnvelopeHash,
    attestationHash: "d".repeat(64),
  });
  const receipt = verifyLoanReceipt(token, "loan-1");

  assert.doesNotThrow(() => assertLoanReleaseEnvelopeHash(receipt, releaseEnvelopeHash));
  assert.throws(() => assertLoanReleaseEnvelopeHash(receipt, "c".repeat(64)), /différente/);
  assert.throws(() => assertLoanReleaseEnvelopeHash(receipt, "invalid"), /invalide/);
});

test("les clés de livraison sont isolées par wallet", () => {
  assert.notEqual(loanModelKey("loan-1", "rAlice"), loanModelKey("loan-1", "rBob"));
  assert.notEqual(selfTrainModelKey("job-1", "rAlice"), selfTrainModelKey("job-1", "rBob"));
  assert.notEqual(
    escrowConditionPublic("loan-1", "rAlice"),
    escrowConditionPublic("loan-1", "rBob"),
  );
});

test("les preuves XRPL sont liées au wallet et à la condition du loan", () => {
  const condition = escrowConditionPublic("loan-1", "rBorrower");
  const create = {
    TransactionType: "EscrowCreate" as const,
    Account: "rBorrower",
    Destination: "rProvider",
    Amount: "10000000",
    Sequence: 7,
    Condition: condition,
    date: 800_000_000,
    CancelAfter: 800_604_800,
  };
  const finish = {
    TransactionType: "EscrowFinish" as const,
    Account: "rVerifier",
    Owner: "rBorrower",
    OfferSequence: 7,
    Condition: condition,
  };
  const scope = {
    loanId: "loan-1",
    borrower: "rBorrower",
    provider: "rProvider",
    sequence: 7,
    amountDrops: "10000000",
    challengeDays: 7,
  };

  assert.doesNotThrow(() => assertEscrowCreateScope(create, scope));
  assert.doesNotThrow(() =>
    assertEscrowCreateScope({ ...create, CancelAfter: create.CancelAfter + 600 }, scope),
  );
  assert.doesNotThrow(() => assertEscrowFinishScope(finish, scope));
  assert.throws(() => assertEscrowCreateScope({ ...create, FinishAfter: 1 }, scope), /hors scope/);
  assert.throws(
    () => assertEscrowCreateScope({ ...create, Amount: "1000" }, scope),
    /hors scope/,
  );
  assert.throws(
    () => assertEscrowCreateScope({ ...create, CancelAfter: create.CancelAfter + 631 }, scope),
    /hors scope/,
  );
  assert.throws(
    () => assertEscrowFinishScope({ ...finish, Owner: "rOther" }, scope),
    /hors scope/,
  );
});

test("la clé modèle traverse Next uniquement sous enveloppe client", async () => {
  const context = "loan:rBorrower:loan-1";
  const delivery = await createRunnerDelivery(context);
  const envelope = encryptRunnerDelivery("model-key-secret", delivery.publicKey, context);

  assert.equal(JSON.stringify(envelope).includes("model-key-secret"), false);
  assert.equal(await delivery.decrypt(envelope), "model-key-secret");
});

test("la capsule modèle reste verrouillée jusqu'au fulfillment XRPL", async () => {
  const context = "loan:rBorrower:loan-atomic";
  const fulfillmentHex = "A0B1C2D3";
  const delivery = await createRunnerReleaseDelivery(context);
  const envelope = encryptRunnerRelease(
    "atomic-model-key",
    delivery.publicKey,
    context,
    fulfillmentHex,
    "xrpl-fulfillment",
  );

  assert.equal(JSON.stringify(envelope).includes("atomic-model-key"), false);
  assert.equal(JSON.stringify(envelope).includes(fulfillmentHex), false);
  await assert.rejects(() => delivery.decrypt(envelope, "A0B1C2D4"));
  assert.equal(await delivery.decrypt(envelope, fulfillmentHex), "atomic-model-key");
});
