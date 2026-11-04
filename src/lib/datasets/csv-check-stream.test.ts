import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMerkleTree } from "@/lib/crypto/merkle";
import type { ModelId } from "@/lib/models/registry";
import { inspectCsv, type CsvInspection } from "./csv-check";
import { inspectStreamSummary, readLargeCsv } from "./csv-check-stream";

const MODELS: ModelId[] = ["linear_regression", "logistic_regression", "gradient_boosted_trees"];

function source(text: string) {
  const bytes = Buffer.from(text);
  return { sizeBytes: bytes.length, read: async (offset: number, length: number) => new Uint8Array(bytes.subarray(offset, offset + length)) };
}

function rows(count: number, row: (i: number) => string, header = "x1,x2,target"): string {
  const lines = [header];
  for (let i = 0; i < count; i++) lines.push(row(i));
  return `${lines.join("\n")}\n`;
}

const CASES: Record<string, string> = {
  valid: rows(12_000, (i) => `${i % 13},${(i * 7) % 11},${i % 2}`),
  continuous: rows(3_000, (i) => `${i % 13},${(i * 7) % 11},${(i * 0.37) % 5}`),
  fewRows: rows(40, (i) => `${i},${i * 2},${i % 2}`),
  oneNumeric: rows(500, (i) => `a${i},${i},b${i}`),
  badHeader: rows(500, (i) => `${i},${i},${i % 2}`, "x,x,target"),
  incompleteTarget: rows(3_000, (i) => `${i % 13},${i % 7},${i === 9 ? "" : i % 2}`),
  multiClass: rows(12_000, (i) => `${i % 13},${(i * 7) % 11},${i % 3}`),
  treesCharset: rows(12_000, (i) => `${i % 13},${(i * 7) % 11},${i % 2}`, "x 1,x2,target"),
  malformed: "a,b\n1,2\n3\n",
  blankLine: "a,b\n1,2\n\n3,4\n",
  quoted: rows(3_000, (i) => `"${i % 13}",${i % 7},${i % 2}`),
  headerOnly: "a,b\n",
};

test("le contrôle en flux d'un gros fichier rend la même décision que le contrôle d'un petit", async () => {
  for (const [name, text] of Object.entries(CASES)) {
    const read = await readLargeCsv(source(text));
    for (const modelId of MODELS) {
      const expected = inspectCsv(text, modelId);
      const actual: CsvInspection = read.ok ? inspectStreamSummary(read.summary, modelId) : { ok: false, reason: read.reason, summary: {} };
      // Seuls écarts admis, comme dans l'enclave : budget de calcul et classes de part et d'autre
      // de la séparation des arbres, vérifiés à l'entraînement.
      if (!expected.ok && (expected.reason.kind === "compute-budget" || expected.reason.kind === "held-out-classes")) {
        assert.equal(actual.ok, true, `${name} / ${modelId}`);
        continue;
      }
      assert.equal(actual.ok, expected.ok, `${name} / ${modelId}`);
      if (!expected.ok && !actual.ok) assert.deepEqual(actual.reason, expected.reason, `${name} / ${modelId}`);
      if (expected.ok && actual.ok) assert.deepEqual(actual.summary, expected.summary, `${name} / ${modelId}`);
    }
  }
});

test("la lecture en flux calcule la racine de Merkle du titre et suit sa progression", async () => {
  const text = CASES.valid.repeat(1).padEnd(3 * 1024 * 1024 + 17, "\n");
  const steps: number[] = [];
  const read = await readLargeCsv(source(text), (fraction) => steps.push(fraction));
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.equal(read.merkleRoot, buildMerkleTree(Buffer.from(text)).root);
  assert.equal(steps.at(-1), 1);
  assert.ok(steps.every((value, index) => index === 0 || value >= steps[index - 1]));
});

test("un texte non UTF-8 est illisible, une lecture annulée s'arrête", async () => {
  const invalid = { sizeBytes: 4, read: async () => new Uint8Array([0x61, 0x2c, 0xff, 0x0a]) };
  assert.deepEqual(await readLargeCsv(invalid), { ok: false, reason: { kind: "unreadable" } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readLargeCsv(source(CASES.valid), undefined, controller.signal));
});
