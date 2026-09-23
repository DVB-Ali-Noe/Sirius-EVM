import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fetchFromIpfs, MAX_IPFS_BLOB_BYTES, uploadToIpfs } from "./pinata";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("le téléchargement s’arrête dès qu’un flux sans Content-Length dépasse le plafond", async () => {
  let cancelled = false;
  globalThis.fetch = async (_input, options) => {
    assert.ok(options?.signal instanceof AbortSignal);
    return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(MAX_IPFS_BLOB_BYTES / 2 + 1)); },
      cancel() { cancelled = true; },
    }));
  };
  await assert.rejects(fetchFromIpfs("bafy-dataset"), /trop volumineuse/);
  assert.equal(cancelled, true);
});

test("une taille déclarée excessive est rejetée sans lire le blob", async () => {
  globalThis.fetch = async () => new Response("", { headers: { "content-length": String(MAX_IPFS_BLOB_BYTES + 1) } });
  await assert.rejects(fetchFromIpfs("bafy-dataset"), /trop volumineuse/);
});

test("un blob autorisé reste identique après lecture bornée", async () => {
  globalThis.fetch = async () => new Response("encrypted-dataset");
  assert.equal((await fetchFromIpfs("bafy-dataset")).toString(), "encrypted-dataset");
});

test("un upload surdimensionné est refusé avant l’appel payant", async () => {
  globalThis.fetch = async () => { assert.fail("upload envoyé"); };
  await assert.rejects(uploadToIpfs(Buffer.alloc(MAX_IPFS_BLOB_BYTES + 1), "test.enc"), /trop volumineux/);
});
