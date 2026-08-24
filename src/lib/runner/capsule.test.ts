import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { encryptRunnerRelease } from "./delivery";
import { createRunnerReleaseDelivery, decryptRunnerRelease } from "./delivery-client";

/**
 * La capsule est le mécanisme du fair-exchange : le borrower la détient **avant**
 * tout paiement, sans pouvoir l'ouvrir, parce qu'il lui manque le secret que seul le
 * règlement publie on-chain.
 *
 * Ces tests portent sur la coexistence des deux rails. Un préimage EVM de 32 octets
 * et un fulfillment XRPL sérialisé en DER ne sont pas la même chose ; il ne doit
 * exister aucun chemin par lequel l'un ouvre une capsule scellée pour l'autre.
 */

const MODEL_KEY = "cle-du-modele-entraine";
const CONTEXT = "loan:0x37f98be7c9d48b5d39e449616e7c70e37e29db13:clx1a2b3c4d5";

const preimageHex = () => `0x${randomBytes(32).toString("hex")}`;

test("une capsule EVM s'ouvre avec le préimage publié on-chain", async () => {
  const delivery = await createRunnerReleaseDelivery(CONTEXT);
  const preimage = preimageHex();

  const envelope = encryptRunnerRelease(MODEL_KEY, delivery.publicKey, CONTEXT, preimage, "evm-preimage");

  assert.equal(envelope.release, "evm-preimage");
  assert.equal(JSON.stringify(envelope).includes(MODEL_KEY), false, "la clé ne doit jamais transiter en clair");

  assert.equal(await decryptRunnerRelease(delivery.privateKey, envelope, CONTEXT, preimage), MODEL_KEY);
});

test("le préfixe 0x est toléré des deux côtés, sans changer le résultat", async () => {
  const delivery = await createRunnerReleaseDelivery(CONTEXT);
  const preimage = preimageHex();
  const nu = preimage.slice(2);

  // Une lecture on-chain rend `0x…`, une dérivation interne peut rendre du hex nu :
  // les deux formes doivent produire exactement la même capsule ouvrable.
  const envelope = encryptRunnerRelease(MODEL_KEY, delivery.publicKey, CONTEXT, nu, "evm-preimage");
  assert.equal(await decryptRunnerRelease(delivery.privateKey, envelope, CONTEXT, preimage), MODEL_KEY);
  assert.equal(await decryptRunnerRelease(delivery.privateKey, envelope, CONTEXT, nu), MODEL_KEY);
});

test("sans le préimage, la capsule reste fermée", async () => {
  const delivery = await createRunnerReleaseDelivery(CONTEXT);
  const envelope = encryptRunnerRelease(MODEL_KEY, delivery.publicKey, CONTEXT, preimageHex(), "evm-preimage");

  // C'est tout le fair-exchange : la capsule est chez le borrower, mais inerte.
  await assert.rejects(() => decryptRunnerRelease(delivery.privateKey, envelope, CONTEXT, preimageHex()));
});

test("une capsule XRPL ne s'ouvre pas avec la logique EVM, et réciproquement", async () => {
  const delivery = await createRunnerReleaseDelivery(CONTEXT);
  const preimage = preimageHex();

  const evm = encryptRunnerRelease(MODEL_KEY, delivery.publicKey, CONTEXT, preimage, "evm-preimage");
  const xrpl = encryptRunnerRelease(MODEL_KEY, delivery.publicKey, CONTEXT, preimage, "xrpl-fulfillment");

  // Même secret, même contexte, même clé ECDH — et pourtant deux capsules distinctes,
  // parce que le préfixe d'info HKDF diffère par rail.
  assert.notEqual(evm.ciphertext, xrpl.ciphertext);

  // Falsifier le champ `release` en transit ne donne accès à rien : il ne fait que
  // choisir le calcul, il ne porte aucune autorité.
  const falsifie = { ...evm, release: "xrpl-fulfillment" as const };
  await assert.rejects(() => decryptRunnerRelease(delivery.privateKey, falsifie, CONTEXT, preimage));

  const inverse = { ...xrpl, release: "evm-preimage" as const };
  await assert.rejects(() => decryptRunnerRelease(delivery.privateKey, inverse, CONTEXT, preimage));
});

test("un contexte divergent ferme la capsule", async () => {
  const delivery = await createRunnerReleaseDelivery(CONTEXT);
  const preimage = preimageHex();
  const envelope = encryptRunnerRelease(MODEL_KEY, delivery.publicKey, CONTEXT, preimage, "evm-preimage");

  // Le contexte est à la fois AAD et suffixe d'info HKDF : une casse divergente
  // suffirait à rendre la capsule inouvrable, d'où sa canonicalisation en amont.
  const autre = CONTEXT.replace("0x37f98be7", "0x37F98BE7");
  await assert.rejects(() => decryptRunnerRelease(delivery.privateKey, envelope, autre, preimage));
});

test("un préimage EVM qui n'a pas 32 octets est refusé des deux côtés", async () => {
  const delivery = await createRunnerReleaseDelivery(CONTEXT);

  for (const court of ["0xdeadbeef", `0x${"ab".repeat(31)}`, `0x${"ab".repeat(33)}`]) {
    assert.throws(
      () => encryptRunnerRelease(MODEL_KEY, delivery.publicKey, CONTEXT, court, "evm-preimage"),
      /Préimage/,
    );
  }

  // La longueur fixe ferme l'ambiguïté de concaténation `salt || secret` :
  // 16 octets de sel puis 32 de secret n'admettent aucun autre découpage.
  const envelope = encryptRunnerRelease(MODEL_KEY, delivery.publicKey, CONTEXT, preimageHex(), "evm-preimage");
  await assert.rejects(
    () => decryptRunnerRelease(delivery.privateKey, envelope, CONTEXT, "0xdeadbeef"),
    /Préimage/,
  );
});
