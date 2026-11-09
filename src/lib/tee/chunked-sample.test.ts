import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { unwrapKey } from "@/lib/crypto/encryption";
import { parseCsv } from "@/lib/sirius/metrics";
import {
  ChunkedUploadEncryptor,
  MERKLE_LEAF_BYTES,
  canonicalManifestJson,
  chunkObjectKey,
  decodeBase64Url,
  manifestObjectKey,
  type ChunkedUploadManifest,
} from "@/lib/upload/chunked";
import { SAMPLE_MAX_BYTES, SAMPLE_MAX_ROWS, chunkedTrainingSample, sampleChunkIndexes, type ChunkedSampleSource } from "./chunked-sample";
import { runSelfTraining, sealChunkedDataset, type ChunkSource } from "./core";
import { datasetIngressPublicKey } from "./ingress";
import { trainSelectedModel } from "./model-registry";
import { MODEL_OPTIONS, modelSelectionForId } from "@/lib/models/registry";

const R2 = { R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", R2_ACCESS_KEY_ID: "runner", R2_SECRET_ACCESS_KEY: "s", R2_BUCKET: "sirius-test" };

before(() => {
  Object.assign(process.env, { TEE_MODE: "stub", SIRIUS_MASTER_KEY: Buffer.alloc(32, 21).toString("base64"), ...R2 });
});

interface Sealed {
  file: Buffer;
  manifest: ChunkedUploadManifest;
  objects: Map<string, Uint8Array<ArrayBuffer>>;
  ref: { datasetId: string; cid: string; wrappedKey: string; merkleRoot: string };
  uploadKey: Buffer;
}

/** Un gros fichier envoyé en morceaux (64 Kio par défaut) puis scellé par l'enclave, comme en production. */
async function sealed(file: Buffer, datasetId = "big-dataset", chunkBytes = MERKLE_LEAF_BYTES): Promise<Sealed> {
  const ids = { datasetId, uploadId: "upload-1" };
  const encryptor = await ChunkedUploadEncryptor.create({
    recipientPublicKey: decodeBase64Url(datasetIngressPublicKey().publicKey),
    ids,
    plainBytes: file.length,
    chunkBytes,
  });
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let i = 0; i < encryptor.chunkCount; i++) {
    const part = new Uint8Array(file.subarray(i * chunkBytes, Math.min((i + 1) * chunkBytes, file.length)));
    const { object } = await encryptor.encrypt(i, part);
    chunks.push(object);
    objects.set(chunkObjectKey(ids, i), object);
  }
  const manifest = await encryptor.manifest();
  objects.set(manifestObjectKey(ids), new Uint8Array(Buffer.from(canonicalManifestJson(manifest))));
  const source: ChunkSource = { readChunk: async (index) => chunks[index] };
  const result = await sealChunkedDataset(datasetId, manifest, file.length, { modelId: "linear_regression", modelVersion: "1.0.0" }, source);
  const ref = { datasetId, cid: result.cid, wrappedKey: result.wrappedKey, merkleRoot: result.merkleRoot };
  return { file, manifest, objects, ref, uploadKey: unwrapKey(result.wrappedKey, `wrap:dataset:v1:${datasetId}`) };
}

function memory(s: Sealed, change?: (key: string, object: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>): ChunkedSampleSource {
  const ids = { datasetId: s.manifest.datasetId, uploadId: s.manifest.uploadId };
  const get = (key: string) => {
    const object = s.objects.get(key)!;
    return change ? change(key, object) : object;
  };
  return { readManifest: async () => get(manifestObjectKey(ids)), readChunk: async (index) => get(chunkObjectKey(ids, index)) };
}

function csv(rows: number): Buffer {
  const lines = ["id,surface,pieces,prix"];
  for (let i = 0; i < rows; i++) lines.push(`${i},${20 + (i % 180)},${1 + (i % 6)},${((i * 1.7) % 900).toFixed(2)}`);
  return Buffer.from(`${lines.join("\n")}\n`);
}

test("les morceaux échantillonnés couvrent tout le fichier, début et fin compris", () => {
  assert.deepEqual(sampleChunkIndexes(5), [0, 1, 2, 3, 4]);
  assert.deepEqual(sampleChunkIndexes(128), [0, 18, 36, 54, 73, 91, 109, 127]);
  assert.deepEqual(sampleChunkIndexes(9), [0, 1, 2, 3, 5, 6, 7, 8]);
});

test("l'échantillon d'un gros fichier est déterministe, borné et réparti sur tout le fichier", async () => {
  const s = await sealed(csv(400_000));
  assert.ok(s.manifest.chunkCount > 100);
  const first = await chunkedTrainingSample(s.ref, s.uploadKey, memory(s));
  const second = await chunkedTrainingSample(s.ref, s.uploadKey, memory(s));
  assert.deepEqual(first, second);
  assert.ok(first.length <= SAMPLE_MAX_BYTES);

  const table = parseCsv(first.toString("utf-8"));
  assert.deepEqual(table[0], ["id", "surface", "pieces", "prix"]);
  const rows = table.slice(1);
  assert.ok(rows.length > 40_000 && rows.length <= SAMPLE_MAX_ROWS, String(rows.length));
  // Chaque ligne est une vraie ligne du fichier, entière.
  for (const row of rows) {
    const i = Number(row[0]);
    assert.deepEqual(row, [String(i), String(20 + (i % 180)), String(1 + (i % 6)), ((i * 1.7) % 900).toFixed(2)]);
  }
  const ids = rows.map((row) => Number(row[0]));
  assert.ok(Math.min(...ids) === 0);
  assert.ok(Math.max(...ids) > 390_000, "la fin du fichier est représentée");
});

test("un petit dataset en morceaux est pris en entier", async () => {
  const s = await sealed(csv(5_000));
  assert.deepEqual(await chunkedTrainingSample(s.ref, s.uploadKey, memory(s)), s.file);
});

test("un manifeste ou un morceau qui ne correspond pas au titre scellé est refusé", async () => {
  const s = await sealed(csv(60_000));
  const ids = { datasetId: s.manifest.datasetId, uploadId: s.manifest.uploadId };
  const flipped = memory(s, (key, object) => {
    if (key !== chunkObjectKey(ids, 0)) return object;
    const changed = object.slice();
    changed[40] ^= 1;
    return changed;
  });
  await assert.rejects(chunkedTrainingSample(s.ref, s.uploadKey, flipped), /Intégrité Merkle invalide/);
  await assert.rejects(chunkedTrainingSample({ ...s.ref, merkleRoot: "0".repeat(64) }, s.uploadKey, memory(s)), /Intégrité Merkle invalide/);
  // Le CID change à chaque scellement : remplacer son dernier caractère par un autre, jamais par lui-même.
  const tamperedCid = s.ref.cid.replace(/.$/, (last) => (last === "0" ? "1" : "0"));
  assert.notEqual(tamperedCid, s.ref.cid);
  await assert.rejects(chunkedTrainingSample({ ...s.ref, cid: tamperedCid }, s.uploadKey, memory(s)), /Intégrité Merkle invalide/);
  const rewritten = memory(s, (key, object) => {
    if (key !== manifestObjectKey(ids)) return object;
    const manifest = JSON.parse(Buffer.from(object).toString()) as ChunkedUploadManifest;
    manifest.chunks[2].sha256 = "f".repeat(64);
    return new Uint8Array(Buffer.from(JSON.stringify(manifest)));
  });
  await assert.rejects(chunkedTrainingSample(s.ref, s.uploadKey, rewritten), /Intégrité Merkle invalide/);
  await assert.rejects(chunkedTrainingSample(s.ref, Buffer.alloc(32, 1), memory(s)), /Intégrité Merkle invalide/);
});

test("des retours à la ligne entre guillemets font prendre le début du fichier, toujours lisible", async () => {
  const lines = ["note,surface,prix"];
  for (let i = 0; i < 80_000; i++) lines.push(`"ligne ${i}\nsuite",${20 + (i % 180)},${(i * 1.7) % 900}`);
  const s = await sealed(Buffer.from(`${lines.join("\n")}\n`));
  const sample = await chunkedTrainingSample(s.ref, s.uploadKey, memory(s));
  const table = parseCsv(sample.toString("utf-8"));
  assert.deepEqual(table[0], ["note", "surface", "prix"]);
  assert.equal(table[1][0], "ligne 0\nsuite");
  assert.ok(table.length > 1000 && table.length - 1 <= SAMPLE_MAX_ROWS && sample.length <= SAMPLE_MAX_BYTES);
  // Jamais de ligne recollée de travers : chaque enregistrement est entier.
  for (const row of table.slice(1)) {
    const i = Number(/^ligne (\d+)\nsuite$/.exec(row[0])?.[1]);
    assert.deepEqual(row, [`ligne ${i}\nsuite`, String(20 + (i % 180)), String((i * 1.7) % 900)]);
  }
});

test("l'échantillon d'un fichier accentué tient en octets, pas seulement en caractères", async () => {
  // Lignes de ~90 octets pour ~70 caractères : avec des morceaux de 1 Mio, la limite d'octets borne
  // l'échantillon avant celle des lignes. Compter en caractères l'aurait porté vers 4 Mio.
  const lines = ["ville,description,surface,prix"];
  for (let i = 0; i < 200_000; i++) lines.push(`Évry-Besançon ${i},Pièce à côté du château — €€€ çàéèê ${i % 97},${20 + (i % 180)},${((i * 1.7) % 900).toFixed(2)}`);
  const file = Buffer.from(`${lines.join("\n")}\n`);
  assert.ok(file.length > 16 * 1024 * 1024 && file.length > 1.25 * file.toString("utf-8").length);
  const s = await sealed(file, "accented-dataset", 16 * MERKLE_LEAF_BYTES);
  const sample = await chunkedTrainingSample(s.ref, s.uploadKey, memory(s));
  assert.ok(sample.length <= SAMPLE_MAX_BYTES, `${sample.length} > ${SAMPLE_MAX_BYTES}`);
  assert.ok(sample.length > SAMPLE_MAX_BYTES * 0.9, "l'échantillon reste plein");
  const table = parseCsv(sample.toString("utf-8"));
  assert.deepEqual(table[0], ["ville", "description", "surface", "prix"]);
  const ids = table.slice(1).map((row) => Number(row[0].replace("Évry-Besançon ", "")));
  assert.ok(Math.max(...ids) > 150_000, "la fin du fichier est représentée");
});

test("l'échantillon de secours d'un fichier accentué tient aussi en octets", async () => {
  // Retours à la ligne entre guillemets : seul le début du fichier est pris, borné en octets.
  const lines = ["note,surface,prix"];
  for (let i = 0; i < 40_000; i++) lines.push(`"€€€€€€€€ ligne ${i}\nsuite €€€€€€€€€€€€€€€€€€€€",${20 + (i % 180)},${(i * 1.7) % 900}`);
  const file = Buffer.from(`${lines.join("\n")}\n`);
  assert.ok(file.length > SAMPLE_MAX_BYTES && file.toString("utf-8").length < SAMPLE_MAX_BYTES);
  const s = await sealed(file, "accented-quoted");
  const sample = await chunkedTrainingSample(s.ref, s.uploadKey, memory(s));
  assert.ok(sample.length <= SAMPLE_MAX_BYTES, `${sample.length} > ${SAMPLE_MAX_BYTES}`);
  const table = parseCsv(sample.toString("utf-8"));
  assert.equal(table[1][0], "€€€€€€€€ ligne 0\nsuite €€€€€€€€€€€€€€€€€€€€");
});

test("un self-train sur un gros dataset relu dans R2 s'entraîne sur l'échantillon", { skip: process.platform === "win32" && "volume privé du runner : droits POSIX" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "sirius-chunked-train-"));
  process.env.RUNNER_SERVED_MODELS_DIR = join(root, "models");
  const s = await sealed(csv(400_000));
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const object = s.objects.get(new URL(String(input)).pathname.replace(`/${R2.R2_BUCKET}/`, ""));
    return object ? new Response(object) : new Response("<Error/>", { status: 404 });
  }) as typeof fetch;
  try {
    const result = await runSelfTraining({
      ...s.ref,
      priceUsdcAtomic: "1000",
      challengeDays: 7,
      maxRentalDays: 30,
      modelId: "linear_regression",
      modelVersion: "1.0.0",
      jobId: "job-chunked",
      owner: "0x1111111111111111111111111111111111111111",
    } as Parameters<typeof runSelfTraining>[0]);
    assert.ok(result.metrics.n > 40_000 && result.metrics.n <= SAMPLE_MAX_ROWS);
    assert.deepEqual(result.features, ["id", "surface", "pieces"]);
  } finally {
    globalThis.fetch = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("les trois profils s'entraînent sur l'échantillon d'un gros fichier", async () => {
  const lines = ["age,revenu,dette,defaut"];
  for (let i = 0; i < 300_000; i++) {
    const age = 18 + (i % 60);
    const revenu = 1000 + ((i * 37) % 5000);
    const dette = (i * 13) % 900;
    lines.push(`${age},${revenu},${dette},${dette * 4 > revenu ? 1 : 0}`);
  }
  const s = await sealed(Buffer.from(`${lines.join("\n")}\n`));
  const sample = await chunkedTrainingSample(s.ref, s.uploadKey, memory(s));
  for (const selection of MODEL_OPTIONS.map((option) => modelSelectionForId(option.id)!)) {
    const model = trainSelectedModel(selection, sample);
    assert.equal(model.target, "defaut", selection.modelId);
    assert.deepEqual(model.features, ["age", "revenu", "dette"], selection.modelId);
  }
});
