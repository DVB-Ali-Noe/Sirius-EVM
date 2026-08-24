import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { AppError } from "@/lib/app-error";

/**
 * Étanchéité des deux rails pendant la coexistence.
 *
 * Le risque, signalé par la revue adversariale : un prêt ouvert sur une chaîne réglé
 * sur l'autre, ou un reçu émis par un runner reconfiguré rejoué contre un nouveau
 * contrat. Comme le reçu est ce qui autorise le règlement, un reçu accepté hors de
 * son contexte signifie un paiement contre un préimage qui n'ouvre rien.
 */

const ESCROW_A = "0xc6a27dd5fdfdeda069b5634ca8d44416dfdb3f4f";
const ESCROW_B = "0xae326acee10138d47623dc0caf9d8b4e970090b1";
const BORROWER = "0x37f98be7c9d48b5d39e449616e7c70e37e29db13";
const PROVIDER = "0x930f5a13d65b3e7e07431a38da30229562e3318b";
const LOAN_ID = "clx1a2b3c4d5e6f7g8h9i0j1k";

async function receiptModule(env: { network?: string; escrow?: string } = {}) {
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
    amountWei: "2000000000000",
    challengeDays: 7,
    deliveryPublicKey: "cle-de-livraison",
    releaseEnvelopeHash: "f".repeat(64),
    attestationHash: "a".repeat(64),
    ...overrides,
  };
}

test("un reçu EVM valide est accepté sous la liaison qui l'a émis", async () => {
  const m = await receiptModule();
  const token = m.issueEvmLoanReceipt(payload());
  const receipt = m.verifyEvmLoanReceipt(token, LOAN_ID);

  assert.equal(receipt.kind, "evm-loan");
  assert.equal(receipt.borrower, BORROWER);
  assert.equal(receipt.amountWei, "2000000000000");
});

test("un reçu XRPL ne peut pas être présenté comme un reçu EVM", async () => {
  const m = await receiptModule();

  const xrpl = m.issueLoanReceipt({
    loanId: LOAN_ID,
    datasetId: "dataset-1",
    borrower: "rBorrowerXrpl11111111111111111",
    provider: "rProviderXrpl11111111111111111",
    modelCid: "bafy-modele",
    escrowTxHash: "A".repeat(64),
    escrowSequence: 42,
    deliveryPublicKey: "cle",
    amountDrops: "2500000",
    challengeDays: 7,
    releaseEnvelopeHash: "f".repeat(64),
    attestationHash: "a".repeat(64),
  });

  // Le `kind` entre dans le HMAC : les deux rails ne partagent aucun jeton.
  assert.throws(() => m.verifyEvmLoanReceipt(xrpl, LOAN_ID), AppError);

  const evm = m.issueEvmLoanReceipt(payload());
  assert.throws(() => m.verifyLoanReceipt(evm, LOAN_ID), AppError);
});

test("un reçu émis pour une autre chaîne est refusé", async () => {
  const emis = await receiptModule({ network: "testnet" });
  const token = emis.issueEvmLoanReceipt(payload());

  // Même master key, même contrat, mais le runner tourne désormais sur le mainnet :
  // ses secrets ne sont plus les mêmes, donc le reçu ne doit plus valoir.
  const relu = await receiptModule({ network: "mainnet" });
  assert.throws(
    () => relu.verifyEvmLoanReceipt(token, LOAN_ID),
    (error: unknown) => error instanceof AppError && error.status === 409,
  );
});

test("un reçu émis pour un autre contrat est refusé", async () => {
  const emis = await receiptModule({ escrow: ESCROW_A });
  const token = emis.issueEvmLoanReceipt(payload({ escrow: ESCROW_A }));

  // Redéploiement du contrat : les préimages repartent à zéro, les anciens reçus
  // désigneraient un prêt dont le secret n'ouvre plus rien.
  const relu = await receiptModule({ escrow: ESCROW_B });
  assert.throws(
    () => relu.verifyEvmLoanReceipt(token, LOAN_ID),
    (error: unknown) => error instanceof AppError && error.status === 409,
  );
});

test("un reçu ne vaut que pour son propre prêt", async () => {
  const m = await receiptModule();
  const token = m.issueEvmLoanReceipt(payload());
  assert.throws(() => m.verifyEvmLoanReceipt(token, "un-autre-pret"), AppError);
});

test("un reçu falsifié est rejeté", async () => {
  const m = await receiptModule();
  const token = m.issueEvmLoanReceipt(payload());
  const [body, signature] = token.split(".");

  // On gonfle le montant dû au provider, en gardant la signature d'origine.
  const altered = JSON.parse(Buffer.from(body, "base64url").toString());
  altered.amountWei = "1";
  const forged = `${Buffer.from(JSON.stringify(altered)).toString("base64url")}.${signature}`;

  assert.throws(() => m.verifyEvmLoanReceipt(forged, LOAN_ID), AppError);
});

test("l'accusé de capsule doit correspondre à celui du reçu", async () => {
  const m = await receiptModule();
  const receipt = m.verifyEvmLoanReceipt(m.issueEvmLoanReceipt(payload()), LOAN_ID);

  m.assertEvmReleaseEnvelopeHash(receipt, "f".repeat(64));

  // C'est la preuve que le borrower détient la capsule AVANT que le paiement ne
  // publie le secret : sans ce contrôle, le fair-exchange n'existe pas.
  assert.throws(() => m.assertEvmReleaseEnvelopeHash(receipt, "e".repeat(64)), AppError);
  assert.throws(() => m.assertEvmReleaseEnvelopeHash(receipt, "pas-un-hash"), AppError);
});
