import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "@/lib/app-error";
import { fetchFromIpfs } from "./pinata";

function avecFetch(reponses: Array<number | Error>): { restaurer: () => void; appels: () => number } {
  const original = globalThis.fetch;
  let appels = 0;
  globalThis.fetch = (async () => {
    const r = reponses[Math.min(appels, reponses.length - 1)];
    appels += 1;
    if (r instanceof Error) throw r;
    return new Response(r === 200 ? "ok" : "", { status: r });
  }) as typeof fetch;
  return { restaurer: () => { globalThis.fetch = original; }, appels: () => appels };
}

test("un refus transitoire du gateway est retenté puis servi", async () => {
  const f = avecFetch([429, 503, 200]);
  try {
    const buffer = await fetchFromIpfs("bafytest");
    assert.equal(buffer.toString(), "ok");
    assert.equal(f.appels(), 3);
  } finally { f.restaurer(); }
});

test("un gateway durablement indisponible devient un 503 lisible, pas un 500 muet", async () => {
  const f = avecFetch([new TypeError("fetch failed")]);
  try {
    await assert.rejects(fetchFromIpfs("bafytest"), (e: unknown) => e instanceof AppError && e.status === 503);
    assert.equal(f.appels(), 3);
  } finally { f.restaurer(); }
});

test("un fichier absent n'est pas retenté", async () => {
  const f = avecFetch([404]);
  try {
    await assert.rejects(fetchFromIpfs("bafytest"), (e: unknown) => e instanceof AppError && e.status === 404);
    assert.equal(f.appels(), 1);
  } finally { f.restaurer(); }
});
