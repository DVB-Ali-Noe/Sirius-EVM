import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";

/**
 * Sépare le préimage d'escrow par chaîne et par contrat.
 *
 * Le risque que ces tests ferment : c'est le **préimage** qui verrouille la capsule
 * du modèle, pas son empreinte. Si le même couple (borrower, loanId) produisait le
 * même secret sur deux déploiements, en publier un sur la chaîne bon marché ouvrirait
 * la capsule de l'autre — le borrower obtiendrait le modèle puis se ferait rembourser,
 * et le provider ne serait jamais payé.
 */

const ESCROW_A = "0xc6a27dd5fdfdeda069b5634ca8d44416dfdb3f4f";
const ESCROW_B = "0xae326acee10138d47623dc0caf9d8b4e970090b1";
const BORROWER = "0x37f98be7c9d48b5d39e449616e7c70e37e29db13";
const LOAN_ID = "clx1a2b3c4d5e6f7g8h9i0j1k";

/** Recharge `core.ts` avec un environnement donné : les modules mettent la clé en cache. */
async function lockUnder(
  env: { network?: string; escrow?: string },
  loanId = LOAN_ID,
  borrower = BORROWER,
) {
  process.env.EVM_NETWORK = env.network ?? "testnet";
  process.env.SIRIUS_ESCROW_ADDRESS = env.escrow ?? ESCROW_A;
  // Le suffixe de requête force un module frais à chaque appel.
  const core = await import(`./core.ts?evm-${randomBytes(6).toString("hex")}`);
  return core.escrowLock(loanId, borrower) as { hashlock: string; preimage: string };
}

test("le hashlock est bien le SHA-256 du préimage", async () => {
  const { hashlock, preimage } = await lockUnder({});

  assert.match(preimage, /^0x[0-9a-f]{64}$/);
  assert.match(hashlock, /^0x[0-9a-f]{64}$/);

  const recomputed = createHash("sha256").update(Buffer.from(preimage.slice(2), "hex")).digest("hex");
  assert.equal(hashlock, `0x${recomputed}`);
});

test("le préimage est déterministe à contexte identique", async () => {
  const first = await lockUnder({});
  const second = await lockUnder({});
  assert.equal(first.preimage, second.preimage, "le runner doit pouvoir régénérer le secret");
});

test("changer de chaîne change le préimage", async () => {
  const testnet = await lockUnder({ network: "testnet" });
  const mainnet = await lockUnder({ network: "mainnet" });

  // Sans cette séparation, un préimage publié sur le testnet ouvrirait la capsule
  // du même prêt sur le mainnet.
  assert.notEqual(testnet.preimage, mainnet.preimage);
  assert.notEqual(testnet.hashlock, mainnet.hashlock);
});

test("changer de contrat change le préimage", async () => {
  const first = await lockUnder({ escrow: ESCROW_A });
  const second = await lockUnder({ escrow: ESCROW_B });

  // Un redéploiement du contrat sur la même chaîne doit repartir de secrets neufs.
  assert.notEqual(first.preimage, second.preimage);
});

test("la casse de l'adresse du contrat n'influe pas sur le préimage", async () => {
  const lower = await lockUnder({ escrow: ESCROW_A });
  const upper = await lockUnder({ escrow: ESCROW_A.toUpperCase().replace("0X", "0x") });

  // Sinon la même configuration écrite en EIP-55 rendrait toutes les capsules inouvrables.
  assert.equal(lower.preimage, upper.preimage);
});

test("la casse de l'adresse du borrower n'influe pas sur le préimage", async () => {
  const lower = await lockUnder({}, LOAN_ID, BORROWER);
  const upper = await lockUnder({}, LOAN_ID, BORROWER.toUpperCase().replace("0X", "0x"));

  assert.equal(lower.preimage, upper.preimage);
});

test("deux prêts distincts n'ont jamais le même secret", async () => {
  const base = await lockUnder({});
  const otherLoan = await lockUnder({}, "un-autre-pret");
  const otherBorrower = await lockUnder({}, LOAN_ID, "0x0000000000000000000000000000000000000001");

  assert.notEqual(base.preimage, otherLoan.preimage);
  assert.notEqual(base.preimage, otherBorrower.preimage);
});

test("le rail EVM ne réutilise pas le secret du rail XRPL", async () => {
  process.env.EVM_NETWORK = "testnet";
  process.env.SIRIUS_ESCROW_ADDRESS = ESCROW_A;
  const core = await import(`./core.ts?rails-${randomBytes(6).toString("hex")}`);

  const evm = core.escrowLock(LOAN_ID, BORROWER) as { preimage: string };
  const xrpl = core.escrowRelease(LOAN_ID, BORROWER) as { fulfillmentHex: string };

  // Le contexte v2 diffère du contexte historique : les deux rails sont étanches,
  // et un prêt migré ne peut pas être réglé avec l'ancien secret.
  assert.ok(!xrpl.fulfillmentHex.toLowerCase().includes(evm.preimage.slice(2)));
});

test("une adresse borrower malformée est refusée", async () => {
  process.env.EVM_NETWORK = "testnet";
  process.env.SIRIUS_ESCROW_ADDRESS = ESCROW_A;
  const core = await import(`./core.ts?bad-${randomBytes(6).toString("hex")}`);

  for (const invalid of ["", "0x", "rProviderXrplAddress111111111", `${BORROWER}00`]) {
    assert.throws(() => core.escrowLock(LOAN_ID, invalid), /borrower/i);
  }
});

test("une configuration d'escrow absente ou invalide échoue fermé", async () => {
  const core = await import(`./core.ts?cfg-${randomBytes(6).toString("hex")}`);

  delete process.env.SIRIUS_ESCROW_ADDRESS;
  delete process.env.NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS;
  process.env.EVM_NETWORK = "testnet";
  assert.throws(() => core.escrowLock(LOAN_ID, BORROWER), /SIRIUS_ESCROW_ADDRESS/);

  process.env.SIRIUS_ESCROW_ADDRESS = "pas-une-adresse";
  assert.throws(() => core.escrowLock(LOAN_ID, BORROWER), /adresse EVM valide/);

  process.env.SIRIUS_ESCROW_ADDRESS = ESCROW_A;
  process.env.EVM_NETWORK = "devnet";
  assert.throws(() => core.escrowLock(LOAN_ID, BORROWER), /EVM_NETWORK/);
});

test("la clé du modèle est séparée par chaîne et par contrat, comme le préimage", async () => {
  process.env.EVM_NETWORK = "testnet";
  process.env.SIRIUS_ESCROW_ADDRESS = ESCROW_A;
  const a = await import(`./core.ts?mk1-${randomBytes(6).toString("hex")}`);
  const keyTestnet = a.evmLoanModelKey(LOAN_ID, BORROWER) as string;

  process.env.EVM_NETWORK = "mainnet";
  const b = await import(`./core.ts?mk2-${randomBytes(6).toString("hex")}`);
  const keyMainnet = b.evmLoanModelKey(LOAN_ID, BORROWER) as string;

  process.env.EVM_NETWORK = "testnet";
  process.env.SIRIUS_ESCROW_ADDRESS = ESCROW_B;
  const c = await import(`./core.ts?mk3-${randomBytes(6).toString("hex")}`);
  const keyAutreContrat = c.evmLoanModelKey(LOAN_ID, BORROWER) as string;

  // Séparer le seul préimage verrouillait le cadenas sans protéger le contenu :
  // la clé du modèle chiffre le blob IPFS, et sans séparation un emprunteur
  // pouvait l'obtenir sur un déploiement pour déchiffrer le modèle d'un autre.
  assert.notEqual(keyTestnet, keyMainnet);
  assert.notEqual(keyTestnet, keyAutreContrat);
});

test("la clé du modèle EVM diffère de celle du rail XRPL", async () => {
  process.env.EVM_NETWORK = "testnet";
  process.env.SIRIUS_ESCROW_ADDRESS = ESCROW_A;
  const core = await import(`./core.ts?mkx-${randomBytes(6).toString("hex")}`);

  assert.notEqual(
    core.evmLoanModelKey(LOAN_ID, BORROWER),
    core.loanModelKey(LOAN_ID, BORROWER),
  );
});
