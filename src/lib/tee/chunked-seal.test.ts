import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildMerkleTree } from "@/lib/crypto/merkle";
import { unwrapKey } from "@/lib/crypto/encryption";
import type { ModelSelection } from "@/lib/models/registry";
import {
  ChunkedUploadEncryptor,
  MERKLE_LEAF_BYTES,
  decodeBase64Url,
  decryptChunk,
  parseChunkedDatasetCid,
  type ChunkedUploadManifest,
  type EncryptedChunk,
} from "@/lib/upload/chunked";
import { AppError } from "@/lib/app-error";
import { sealChunkedDataset, type ChunkSource } from "./core";
import { datasetIngressPublicKey } from "./ingress";
import { validateTrainingDataset } from "./train";

before(() => {
  process.env.TEE_MODE = "stub";
  process.env.SIRIUS_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
});

const LINEAR: ModelSelection = { modelId: "linear_regression", modelVersion: "1.0.0" };
const LOGISTIC: ModelSelection = { modelId: "logistic_regression", modelVersion: "1.0.0" };

function trainingCsv(rows: number, target: (i: number) => string = (i) => String(i % 2)): Buffer {
  const lines = ["x1,x2,label,target"];
  for (let i = 0; i < rows; i++) lines.push(`${(i * 0.37) % 11},${(i * 1.3) % 7},ligne ${i},${target(i)}`);
  return Buffer.from(`${lines.join("\n")}\n`);
}

/** Le fournisseur chiffre pour la vraie clé d'ingestion du runner, en morceaux de 64 Kio. */
async function upload(file: Buffer, datasetId = "dataset-big") {
  const encryptor = await ChunkedUploadEncryptor.create({
    recipientPublicKey: decodeBase64Url(datasetIngressPublicKey().publicKey),
    ids: { datasetId, uploadId: "upload-1" },
    plainBytes: file.length,
    chunkBytes: MERKLE_LEAF_BYTES,
  });
  const objects: EncryptedChunk[] = [];
  for (let i = 0; i < encryptor.chunkCount; i++) {
    const part = file.subarray(i * MERKLE_LEAF_BYTES, Math.min((i + 1) * MERKLE_LEAF_BYTES, file.length));
    objects.push(await encryptor.encrypt(i, new Uint8Array(part)));
  }
  return { manifest: await encryptor.manifest(), objects };
}

function memorySource(objects: EncryptedChunk[], replace?: (index: number, object: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>): ChunkSource {
  return {
    async readChunk(index) {
      const object = objects[index].object;
      return replace ? replace(index, object) : object;
    },
  };
}

function copy(manifest: ChunkedUploadManifest): ChunkedUploadManifest {
  return JSON.parse(JSON.stringify(manifest)) as ChunkedUploadManifest;
}

test("un envoi en morceaux est scellé par l'enclave avec la racine et les métriques du fichier", async () => {
  const file = trainingCsv(6000);
  const { manifest, objects } = await upload(file);
  assert.ok(manifest.chunkCount > 1);

  const sealed = await sealChunkedDataset("dataset-big", manifest, file.length, LINEAR, memorySource(objects));

  assert.equal(sealed.merkleRoot, buildMerkleTree(file).root);
  assert.equal(sealed.sizeBytes, file.length);
  assert.deepEqual(sealed.metrics, validateTrainingDataset(file, LINEAR));
  assert.equal(parseChunkedDatasetCid(sealed.cid)?.uploadId, "upload-1");

  // La clé enveloppée est bien celle de l'envoi : elle rouvre les morceaux stockés.
  const uploadKey = unwrapKey(sealed.wrappedKey, "wrap:dataset:v1:dataset-big");
  const key = await crypto.subtle.importKey("raw", new Uint8Array(uploadKey), "AES-GCM", false, ["decrypt"]);
  const first = await decryptChunk(key, manifest, 0, manifest.chunkCount, manifest.chunks[0].plainBytes, objects[0].object);
  assert.deepEqual(Buffer.from(first), file.subarray(0, MERKLE_LEAF_BYTES));
});

test("un morceau stocké modifié ou échangé est refusé", async () => {
  const file = trainingCsv(6000);
  const { manifest, objects } = await upload(file);

  const flipped = memorySource(objects, (index, object) => {
    if (index !== 1) return object;
    const changed = object.slice();
    changed[100] ^= 1;
    return changed;
  });
  await assert.rejects(
    sealChunkedDataset("dataset-big", manifest, file.length, LINEAR, flipped),
    (error: unknown) => error instanceof AppError && error.status === 400 && /Morceau 1 différent/.test(error.message),
  );

  const swapped = memorySource(objects, (index) => objects[index === 0 ? 1 : index === 1 ? 0 : index].object);
  await assert.rejects(sealChunkedDataset("dataset-big", manifest, file.length, LINEAR, swapped), /Morceau 0 différent/);
});

test("un manifeste d'un autre dataset, d'une autre taille ou d'une autre racine est refusé", async () => {
  const file = trainingCsv(3000);
  const { manifest, objects } = await upload(file);
  const source = memorySource(objects);

  await assert.rejects(sealChunkedDataset("autre-dataset", manifest, file.length, LINEAR, source), /ne correspond pas à ce dataset/);
  await assert.rejects(sealChunkedDataset("dataset-big", manifest, file.length + 1, LINEAR, source), /La taille du fichier/);

  const otherRoot = copy(manifest);
  otherRoot.plaintextRoot = "0".repeat(64);
  await assert.rejects(sealChunkedDataset("dataset-big", otherRoot, file.length, LINEAR, source), /La racine du fichier/);

  const otherDigest = copy(manifest);
  otherDigest.chunks[0].sha256 = "f".repeat(64);
  await assert.rejects(sealChunkedDataset("dataset-big", otherDigest, file.length, LINEAR, source), /racine du chiffré/);
});

test("un envoi ne se rejoue pas sous un autre identifiant de dataset", async () => {
  const file = trainingCsv(3000);
  const { manifest, objects } = await upload(file);
  const renamed = copy(manifest);
  renamed.datasetId = "dataset-vole";
  // Même morceaux, manifeste réécrit : la clé dérivée change, plus rien ne se déchiffre.
  await assert.rejects(
    sealChunkedDataset("dataset-vole", renamed, file.length, LINEAR, memorySource(objects)),
    /Morceau 0 illisible/,
  );
});

test("les refus d'ingestion donnent le même message qu'un petit fichier", async () => {
  const cases: { file: Buffer; model: ModelSelection }[] = [
    { file: trainingCsv(50), model: LINEAR },
    { file: trainingCsv(3000, (i) => (i === 7 ? "" : String(i % 2))), model: LINEAR },
    { file: trainingCsv(3000, (i) => String(i % 3)), model: LOGISTIC },
    { file: Buffer.from("a,b\nx,1\ny,2\n"), model: LINEAR },
    { file: Buffer.from("a,a,c\n1,2,3\n"), model: LINEAR },
    { file: Buffer.from("a,b\n1,2\n\n3,4\n"), model: LINEAR },
  ];
  for (const [index, { file, model }] of cases.entries()) {
    let expected = "";
    try {
      validateTrainingDataset(file, model);
    } catch (error) {
      expected = (error as Error).message;
    }
    assert.ok(expected, `cas ${index} : le petit fichier devrait être refusé`);
    const { manifest, objects } = await upload(file);
    await assert.rejects(
      sealChunkedDataset("dataset-big", manifest, file.length, model, memorySource(objects)),
      (error: unknown) => error instanceof AppError && error.status === 400 && error.message === expected,
      `cas ${index}`,
    );
  }
});
