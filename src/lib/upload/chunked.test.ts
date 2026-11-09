import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { buildMerkleTree } from "@/lib/crypto/merkle";
import {
  ChunkedUploadEncryptor,
  MAX_CHUNKED_DATASET_BYTES,
  MERKLE_LEAF_BYTES,
  UPLOAD_CHUNK_BYTES,
  chunkCountFor,
  decodeBase64Url,
  decryptChunk,
  manifestSha256,
  parseChunkedUploadManifest,
  uploadKeyFromSharedSecret,
  type ChunkedUploadManifest,
  type EncryptedChunk,
  type UploadIds,
} from "./chunked";

const ids: UploadIds = { datasetId: "dataset_1", uploadId: "upload-1" };

/** Destinataire de test : une paire P-256 Web Crypto à la place de la clé d'ingestion de l'enclave. */
async function recipient() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  async function openKey(manifest: ChunkedUploadManifest, forIds: UploadIds = manifest): Promise<CryptoKey> {
    const ephemeral = await crypto.subtle.importKey(
      "raw",
      decodeBase64Url(manifest.key.ephemeralPublicKey),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeral }, pair.privateKey, 256));
    return uploadKeyFromSharedSecret(shared, decodeBase64Url(manifest.key.salt), forIds, ["decrypt"]);
  }
  return { publicKey, openKey };
}

function slice(file: Buffer, index: number, chunkBytes: number): Uint8Array<ArrayBuffer> {
  const part = file.subarray(index * chunkBytes, Math.min((index + 1) * chunkBytes, file.length));
  return new Uint8Array(part);
}

async function encryptFile(file: Buffer, publicKey: Uint8Array<ArrayBuffer>, chunkBytes: number, order?: number[]) {
  const encryptor = await ChunkedUploadEncryptor.create({ recipientPublicKey: publicKey, ids, plainBytes: file.length, chunkBytes });
  const objects: EncryptedChunk[] = [];
  for (const index of order ?? [...Array(encryptor.chunkCount).keys()]) {
    objects[index] = await encryptor.encrypt(index, slice(file, index, chunkBytes));
  }
  return { encryptor, objects, manifest: await encryptor.manifest() };
}

async function decryptAll(manifest: ChunkedUploadManifest, objects: EncryptedChunk[], key: CryptoKey): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const chunk of manifest.chunks) {
    parts.push(
      Buffer.from(await decryptChunk(key, manifest, chunk.index, manifest.chunkCount, chunk.plainBytes, objects[chunk.index].object)),
    );
  }
  return Buffer.concat(parts);
}

test("un fichier chiffré en morceaux, dans le désordre, se rouvre à l'identique côté enclave", async () => {
  const { publicKey, openKey } = await recipient();
  const chunkBytes = MERKLE_LEAF_BYTES;
  const file = randomBytes(chunkBytes * 3 + 123);
  const { manifest, objects } = await encryptFile(file, publicKey, chunkBytes, [2, 0, 3, 1]);

  assert.equal(manifest.chunkCount, 4);
  assert.deepEqual(
    manifest.chunks.map((chunk) => chunk.plainBytes),
    [chunkBytes, chunkBytes, chunkBytes, 123],
  );
  assert.deepEqual(await parseChunkedUploadManifest(JSON.parse(JSON.stringify(manifest))), manifest);
  assert.deepEqual(await decryptAll(manifest, objects, await openKey(manifest)), file);
});

test("la racine du clair est celle de buildMerkleTree, avec les morceaux de 8 Mio par défaut", async () => {
  const { publicKey } = await recipient();
  const file = randomBytes(UPLOAD_CHUNK_BYTES * 2 + 1000);
  const { manifest } = await encryptFile(file, publicKey, UPLOAD_CHUNK_BYTES);

  assert.equal(manifest.chunkCount, 3);
  assert.equal(manifest.plaintextRoot, buildMerkleTree(file).root);
});

test("un fichier plus petit qu'une feuille garde la racine de buildMerkleTree", async () => {
  const { publicKey } = await recipient();
  const file = Buffer.from("feature,target\n1,0\n2,1\n");
  const { manifest } = await encryptFile(file, publicKey, UPLOAD_CHUNK_BYTES);

  assert.equal(manifest.chunkCount, 1);
  assert.equal(manifest.plaintextRoot, buildMerkleTree(file).root);
});

test("un morceau déplacé, tronqué ou venu d'un autre envoi ne se déchiffre pas", async () => {
  const { publicKey, openKey } = await recipient();
  const chunkBytes = MERKLE_LEAF_BYTES;
  const file = randomBytes(chunkBytes * 2);
  const { manifest, objects } = await encryptFile(file, publicKey, chunkBytes);
  const key = await openKey(manifest);

  // Indice échangé : les deux morceaux ont la même taille, seules les données associées diffèrent.
  await assert.rejects(decryptChunk(key, manifest, 1, 2, chunkBytes, objects[0].object), /Morceau chiffré invalide/);
  // Nombre de morceaux annoncé différent (morceau retiré du manifeste).
  await assert.rejects(decryptChunk(key, manifest, 0, 1, chunkBytes, objects[0].object), /Morceau chiffré invalide/);
  // Objet tronqué.
  await assert.rejects(
    decryptChunk(key, manifest, 0, 2, chunkBytes, objects[0].object.slice(0, -1)),
    /Morceau chiffré invalide/,
  );
  // Un bit modifié.
  const flipped = objects[0].object.slice();
  flipped[40] ^= 1;
  await assert.rejects(decryptChunk(key, manifest, 0, 2, chunkBytes, flipped), /Morceau chiffré invalide/);
  // Autre envoi : la clé dérivée change avec l'identifiant d'envoi.
  const otherKey = await openKey(manifest, { datasetId: ids.datasetId, uploadId: "upload-2" });
  await assert.rejects(decryptChunk(otherKey, manifest, 0, 2, chunkBytes, objects[0].object), /Morceau chiffré invalide/);
});

test("un manifeste modifié est refusé", async () => {
  const { publicKey } = await recipient();
  const chunkBytes = MERKLE_LEAF_BYTES;
  const { manifest } = await encryptFile(randomBytes(chunkBytes * 2 + 5), publicKey, chunkBytes);
  const copy = () => JSON.parse(JSON.stringify(manifest)) as ChunkedUploadManifest;

  const otherDigest = copy();
  otherDigest.chunks[1].sha256 = "0".repeat(64);
  await assert.rejects(parseChunkedUploadManifest(otherDigest), /racine du chiffré/);

  const otherSize = copy();
  otherSize.plainBytes += 1;
  await assert.rejects(parseChunkedUploadManifest(otherSize), /morceau 2/);

  const dropped = copy();
  dropped.chunks.pop();
  await assert.rejects(parseChunkedUploadManifest(dropped), /nombre de morceaux/);

  const swapped = copy();
  [swapped.chunks[0], swapped.chunks[1]] = [swapped.chunks[1], swapped.chunks[0]];
  await assert.rejects(parseChunkedUploadManifest(swapped), /morceau 0/);

  const badId = copy();
  badId.datasetId = "a\nb";
  await assert.rejects(parseChunkedUploadManifest(badId), /identifiants/);

  const badKey = copy();
  badKey.key.salt = "AAAA";
  await assert.rejects(parseChunkedUploadManifest(badKey), /clé d'envoi/);
});

test("l'empreinte du manifeste ne dépend pas de l'ordre des clés reçues", async () => {
  const { publicKey } = await recipient();
  const { manifest } = await encryptFile(randomBytes(1000), publicKey, UPLOAD_CHUNK_BYTES);
  const reordered = Object.fromEntries(Object.entries(manifest).reverse()) as ChunkedUploadManifest;

  assert.match(await manifestSha256(manifest), /^[0-9a-f]{64}$/);
  assert.equal(await manifestSha256(reordered), await manifestSha256(manifest));
});

test("les tailles hors bornes et les envois incomplets sont refusés", async () => {
  const { publicKey } = await recipient();
  const chunkBytes = MERKLE_LEAF_BYTES;

  assert.throws(() => chunkCountFor(0), /Taille du dataset invalide/);
  assert.throws(() => chunkCountFor(MAX_CHUNKED_DATASET_BYTES + 1), /Taille du dataset invalide/);
  assert.equal(chunkCountFor(MAX_CHUNKED_DATASET_BYTES), 128);
  assert.throws(() => chunkCountFor(10, MERKLE_LEAF_BYTES + 1), /Taille de morceau invalide/);
  await assert.rejects(
    ChunkedUploadEncryptor.create({ recipientPublicKey: publicKey.slice(1), ids, plainBytes: 10 }),
    /Clé d'ingestion invalide/,
  );
  await assert.rejects(
    ChunkedUploadEncryptor.create({ recipientPublicKey: publicKey, ids: { ...ids, uploadId: "../x" }, plainBytes: 10 }),
    /Identifiant d'envoi invalide/,
  );

  const encryptor = await ChunkedUploadEncryptor.create({ recipientPublicKey: publicKey, ids, plainBytes: chunkBytes + 1, chunkBytes });
  await assert.rejects(encryptor.encrypt(1, new Uint8Array(2)), /Taille de morceau inattendue/);
  await assert.rejects(encryptor.encrypt(2, new Uint8Array(1)), /Indice de morceau invalide/);
  await encryptor.encrypt(0, new Uint8Array(chunkBytes));
  await assert.rejects(encryptor.manifest(), /Morceau 1 pas encore chiffré/);
});
