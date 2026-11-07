import assert from "node:assert/strict";
import { test } from "node:test";
import { CsvValidationError, columnCells, parseCsv } from "@/lib/sirius/metrics";
import { StrictCsvStream } from "./csv-stream";

/** Générateur déterministe : les découpages sont reproductibles d'une exécution à l'autre. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

type Outcome = { rows: string[][] } | { error: string };

function viaParseCsv(text: string): Outcome {
  try {
    return { rows: parseCsv(text) };
  } catch (error) {
    assert.ok(error instanceof CsvValidationError);
    return { error: error.message };
  }
}

/** Les octets UTF-8 du texte, coupés à des positions aléatoires (y compris au milieu d'un caractère). */
function viaStream(text: string, seed: number): Outcome {
  const bytes = new TextEncoder().encode(text);
  const next = random(seed);
  const rows: string[][] = [];
  try {
    const stream = new StrictCsvStream((row, header) => {
      if (rows.length === 0) rows.push(header);
      rows.push(row);
    }, { maxRows: 50_000 });
    let offset = 0;
    while (offset < bytes.length) {
      const size = 1 + Math.floor(next() * 7);
      stream.pushBytes(bytes.subarray(offset, offset + size));
      offset += size;
    }
    const summary = stream.end();
    if (rows.length === 0 && summary.header.length > 0) rows.push(summary.header);
    return { rows };
  } catch (error) {
    assert.ok(error instanceof CsvValidationError);
    return { error: error.message };
  }
}

const CASES = [
  "",
  "a,b,target\n1,2,0\n3,4,1\n",
  "a,b,target\r\n1,2,0\r\n3,4,1",
  "﻿a,b\n1,2\n",
  'nom,valeur\n"Dupont, Jean",3\n"dit ""bonjour""",4\n',
  'nom,valeur\n"sur\ndeux lignes",3\n',
  "é,ü,cible\nçà,ß,1\n日本,語,0\n",
  "a,b\n1,2\n\n\n",
  "a,b\n,\n1,\n",
  // Refusés, avec la même ligne et le même message que `parseCsv`.
  "a,b\n1,2\r3,4\n",
  'a,b\n1,x"y\n',
  'a,b\n"1"x,2\n',
  'a,b\n"jamais fermé,2\n',
  "a,b\n1,2\n\n3,4\n",
  "a,b\n1,2,3\n",
  "a,b\n1\n",
  "a,b\n1,2\r",
];

test("le flux donne exactement les lignes et les erreurs de parseCsv, quel que soit le découpage", () => {
  for (const [index, text] of CASES.entries()) {
    const expected = viaParseCsv(text);
    for (let seed = 1; seed <= 25; seed++) {
      assert.deepEqual(viaStream(text, seed * 7919 + index), expected, `cas ${index}, découpage ${seed}`);
    }
  }
});

test("un fichier aléatoire valide garde la parité avec parseCsv", () => {
  const next = random(42);
  const cells = ["0", "1", "-2.5", "1e3", "", " ", "abc", '"x,y"', '"a""b"', '"l1\nl2"', "é"];
  for (let file = 0; file < 40; file++) {
    const columns = 1 + Math.floor(next() * 5);
    const lines = [Array.from({ length: columns }, (_, i) => `c${i}`).join(",")];
    for (let r = 0; r < 1 + Math.floor(next() * 30); r++) {
      lines.push(Array.from({ length: columns }, () => cells[Math.floor(next() * cells.length)]).join(","));
    }
    const text = lines.join(next() < 0.5 ? "\n" : "\r\n") + (next() < 0.5 ? "\n" : "");
    assert.deepEqual(viaStream(text, file + 1), viaParseCsv(text), `fichier ${file}`);
  }
});

test("le résumé compte chaque colonne comme columnCells, avec les 0 et les 1 exacts", () => {
  const text = "x,cible\n1,0\n0,1\n3,\n4,abc\n5,1\n1.0, 1\n";
  const stream = new StrictCsvStream();
  stream.pushText(text);
  const summary = stream.end();
  const [, ...rows] = parseCsv(text);

  assert.equal(summary.rowCount, 6);
  assert.equal(summary.columnCount, 2);
  assert.deepEqual(summary.columns, [
    { ...columnCells(rows, 0), zeros: 1, ones: 1 },
    { ...columnCells(rows, 1), zeros: 1, ones: 2 },
  ]);
});

test("le plafond de lignes et l'UTF-8 invalide sont refusés", () => {
  const capped = new StrictCsvStream(undefined, { maxRows: 2 });
  assert.throws(() => {
    capped.pushText("a\n1\n2\n3\n");
    capped.end();
  }, /trop de lignes CSV \(max 2\)/);

  const invalid = new StrictCsvStream();
  assert.throws(() => {
    invalid.pushBytes(Uint8Array.of(0x61, 0x0a, 0xff, 0x0a));
    invalid.end();
  }, /texte non UTF-8/);

  const truncated = new StrictCsvStream();
  truncated.pushBytes(Uint8Array.of(0x61, 0x0a, 0xc3));
  assert.throws(() => truncated.end(), /texte non UTF-8/);
});
