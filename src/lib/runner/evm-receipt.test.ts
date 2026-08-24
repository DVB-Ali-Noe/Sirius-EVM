import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { AppError } from "@/lib/app-error";

const ESCROW_A = "0xc6a27dd5fdfdeda069b5634ca8d44416dfdb3f4f";
const ESCROW_B = "0xae326acee10138d47623dc0caf9d8b4e970090b1";
const BORROWER = "0x37f98be7c9d48b5d39e449616e7c70e37e29db13";
const PROVIDER = "0x930f5a13d65b3e7e07431a38da30229562e3318b";
const LOAN_ID = "clx1a2b3c4d5e6f7g8h9i0j1k";

async function receiptModule(env: { network?: string; escrow?: string } = {}) {
  process.env.SIRIUS_MASTER_KEY ??= Buffer.alloc(32, 7).toString("base64");
  process.env.EVM_NETWORK = env.network ?? "testnet";
  process.env.SIRIUS_ESCROW_ADDRESS = env.escrow ?? ESCROW_A;
  return import(`./receipt.ts?r-${randomBytes(6).toString("hex")}`);
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    loanId: LOAN_ID,
    datasetId: "dataset-1",
    borrower: BORROWER,
    provider: PROVIDER,
    modelCid: "bafy-modele",
    loanKey: `0x${"ab".repeat(32)}`,
    chainId: 46630,
    escrow: ESCROW_A,
    amountUsdcAtomic: "2500000",
    challengeDays: 7,
    deliveryPublicKey: "cle-de-livraison",
    releaseEnvelopeHash: "f".repeat(64),
    attestationHash: "a".repeat(64),
    ...overrides,
  };
}

test("un reçu USDC valide est accepté sous la liaison qui l'a émis", async () => {
  const m = await receiptModule();
  const receipt = m.verifyLoanReceipt(m.issueLoanReceipt(payload()), LOAN_ID);
  assert.equal(receipt.amountUsdcAtomic, "2500000");
  assert.equal(receipt.kind, "loan");
});

test("un reçu est lié à sa chaîne et son contrat", async () => {
  const emitted = await receiptModule();
  const token = emitted.issueLoanReceipt(payload());

  const otherNetwork = await receiptModule({ network: "mainnet" });
  assert.throws(() => otherNetwork.verifyLoanReceipt(token, LOAN_ID), AppError);

  const otherEscrow = await receiptModule({ escrow: ESCROW_B });
  assert.throws(() => otherEscrow.verifyLoanReceipt(token, LOAN_ID), AppError);
});

test("un reçu falsifié ou hors prêt est refusé", async () => {
  const m = await receiptModule();
  const token = m.issueLoanReceipt(payload());
  const [body, signature] = token.split(".");
  const forgedBody = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>;
  forgedBody.amountUsdcAtomic = "1";
  const forged = `${Buffer.from(JSON.stringify(forgedBody)).toString("base64url")}.${signature}`;

  assert.throws(() => m.verifyLoanReceipt(forged, LOAN_ID), AppError);
  assert.throws(() => m.verifyLoanReceipt(token, "autre-pret"), AppError);
});

test("la capsule persistée doit être celle attestée", async () => {
  const m = await receiptModule();
  const receipt = m.verifyLoanReceipt(m.issueLoanReceipt(payload()), LOAN_ID);
  m.assertReleaseEnvelopeHash(receipt, "f".repeat(64));
  assert.throws(() => m.assertReleaseEnvelopeHash(receipt, "e".repeat(64)), AppError);
});
