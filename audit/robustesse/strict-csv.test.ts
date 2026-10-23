/**
 * Tests de la proposition de parseur strict (audit/robustesse/strict-csv.ts), non branchée.
 *
 *   TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/robustesse/strict-csv.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { CsvValidationError, parseCsv } from "@/lib/sirius/metrics";
import { isNumericCell } from "@/lib/datasets/csv-check";
import type { ModelSelection } from "@/lib/models/registry";
import { denseTwoChar, prng, publicCreditRisk, syntheticBinary } from "./datasets";
import { ingest, LINEAR, LOGISTIC, train } from "./hostile";
import { isStrictNumericCell, parseCsvStrict } from "./strict-csv";

const CLEAN = publicCreditRisk().replace(/\n+$/, "\n");
const [HEADER, ...BODY] = CLEAN.split("\n").filter(Boolean);
const join = (header: string, body: string[], ending = "\n") => `${[header, ...body].join(ending)}${ending}`;
const mapCell = (column: number, map: (cell: string, row: number) => string, every = 1) =>
  join(HEADER, BODY.map((line, row) => {
    if (row % every !== 0) return line;
    const cells = line.split(",");
    cells[column] = map(cells[column], row);
    return cells.join(",");
  }));

test("fichiers valides : le parseur strict rend exactement le même tableau que parseCsv", () => {
  const files = ["credit-risk.csv", "credit-risk-train.csv", "credit-risk-test.csv"]
    .map((name) => readFileSync(resolve(process.cwd(), "public/examples/classification", name), "utf-8"));
  files.push(syntheticBinary(500, 8), denseTwoChar(300, 10, 5), syntheticBinary(200, 3).replaceAll("\n", "\r\n"),
    'a,"b,c",d\n1,"x""y",2\n3,"multi\nligne",4\n');
  for (const text of files) assert.deepEqual(parseCsvStrict(text), parseCsv(text));
});

test("fichiers ambigus : refus explicite (400) au lieu d'une lecture silencieuse", () => {
  const rejected: Record<string, string> = {
    "\\r isolé": [HEADER, ...BODY].map((l, i) => l + (i === 8 ? "\r" : "\n")).join(""),
    "\\r dans une cellule": mapCell(1, (c, r) => (r === 3 ? c.replace(".", "\r") : c)),
    "guillemet non fermé (milieu)": mapCell(1, (c, r) => (r === 100 ? `"${c}` : c)),
    "guillemet non fermé (fin)": `${CLEAN.slice(0, -2)}"${CLEAN.slice(-2)}`,
    "guillemet au milieu d'un champ": mapCell(1, (c, r) => (r === 5 ? `6"2` : c)),
    "virgule finale": join(HEADER, BODY.map((l) => `${l},`)),
    "virgule décimale non citée": mapCell(1, (c, r) => (r === 7 ? c.replace(".", ",") : c)),
    "ligne tronquée": join(HEADER, BODY.map((l, i) => (i === 7 ? l.slice(0, l.lastIndexOf(",")) : l))),
    "ligne vide au milieu": join(HEADER, [...BODY.slice(0, 10), "", ...BODY.slice(10)]),
    "fichier en \\r seuls": join(HEADER, BODY, "\r"),
  };
  for (const [name, text] of Object.entries(rejected)) {
    assert.throws(() => parseCsvStrict(text), CsvValidationError, name);
  }
});

test("BOM, \\r\\n mélangés et lignes vides finales : lus comme le fichier propre", () => {
  const expected = parseCsv(CLEAN);
  assert.deepEqual(parseCsvStrict(`﻿${CLEAN}`), expected);
  assert.deepEqual(parseCsvStrict(`${CLEAN}\n\n`), expected);
  assert.deepEqual(parseCsvStrict([HEADER, ...BODY].map((l, i) => l + (i % 3 ? "\n" : "\r\n")).join("")), expected);
});

test("isStrictNumericCell : écriture décimale seulement", () => {
  const accepted = ["0", "-0", "+1", "1.5", ".5", "5.", "1e3", "-2.5E-4", "1e12", "1000000000000"];
  const refused = ["0x1A", "0X1a", "0b101", "0o17", " 5", "5 ", "  ", "\t", "", "NaN", "Infinity", "1e300", "1_000", "1,5", "﻿5", " 7", "1e12.5", "1e1000", "--1"];
  for (const cell of accepted) assert.equal(isStrictNumericCell(cell), true, cell);
  for (const cell of refused) assert.equal(isStrictNumericCell(cell), false, cell);
  // Écart avec la règle actuelle (`isNumericCell`, csv-check.ts:79 = `isNum`, train.ts:29).
  const lax = refused.filter((cell) => isNumericCell(cell));
  assert.deepEqual(lax, ["0x1A", "0X1a", "0b101", "0o17", " 5", "5 ", "  ", "\t", "﻿5", " 7"]);
});

test("fuzz : le parseur strict ne lève que CsvValidationError", () => {
  const random = prng(7);
  const alphabet = ["a", "1", ",", '"', "\n", "\r", "\r\n", " ", "﻿", "x".repeat(4_000), ",".repeat(70)];
  for (let run = 0; run < 20_000; run++) {
    let text = "";
    for (let i = Math.floor(random() * 50); i > 0; i--) text += alphabet[Math.floor(random() * alphabet.length)];
    try { parseCsvStrict(text); } catch (error) { assert.ok(error instanceof CsvValidationError, String(error)); }
  }
});

/** Simulation fidèle d'un `isNum` strict : on remplace les cellules non strictes par « NA » (déjà non numérique pour `Number`). */
function strictIngest(text: string, selection: ModelSelection) {
  const table = parseCsvStrict(text);
  const rebuilt = table.map((row, index) => row.map((cell) => (index === 0 || isStrictNumericCell(cell) || !isNumericCell(cell) ? cell : "NA"))
    .map((cell) => (/[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join(",")).join("\n");
  return { ingestion: ingest(rebuilt, selection), training: train(rebuilt, selection) };
}

test("effet sur le modèle : hexadécimal et cellules d'espaces ne deviennent plus des nombres", () => {
  const hexIds = join(`client_ref,${HEADER}`, BODY.map((l, i) => `0x${((i * 2654435761) >>> 8).toString(16)},${l}`));
  const spaces = mapCell(1, () => " ", 10);
  const current = train(hexIds, LOGISTIC);
  const strict = strictIngest(hexIds, LOGISTIC).training;
  assert.equal(current.kind, "trained");
  assert.equal(strict.kind, "trained");
  if (current.kind === "trained" && strict.kind === "trained") {
    assert.ok(current.model.features.includes("client_ref"), "règle actuelle : l'identifiant hexadécimal devient une variable");
    assert.ok(!strict.model.features.includes("client_ref"), "règle stricte : colonne texte, écartée");
    console.log(`[hex-id] variables actuelles : ${current.model.features.join(", ")} ; strictes : ${strict.model.features.join(", ")}`);
  }
  for (const selection of [LOGISTIC, LINEAR]) {
    const now = train(spaces, selection);
    const proposed = strictIngest(spaces, selection).training;
    assert.ok(now.kind === "trained" && proposed.kind === "trained");
    if (now.kind === "trained" && proposed.kind === "trained") {
      assert.ok(now.model.features.includes("income_k_eur"), "règle actuelle : \" \" lu comme 0, colonne gardée");
      assert.ok(!proposed.model.features.includes("income_k_eur"), "règle stricte : même traitement qu'une cellule vide");
      console.log(`[espaces] ${selection.modelId} actuel ${JSON.stringify(now.model.metrics)} / strict ${JSON.stringify(proposed.model.metrics)}`);
    }
  }
});

test("coût : le parseur strict reste du même ordre que parseCsv sur 3 Mo", () => {
  const text = denseTwoChar(49_999, 20);
  const time = (parse: (value: string) => unknown) => {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) { const t0 = performance.now(); parse(text); samples.push(performance.now() - t0); }
    return samples.sort((a, b) => a - b)[2];
  };
  const current = time(parseCsv);
  const strict = time(parseCsvStrict);
  console.log(`[coût] ${text.length} octets : parseCsv ${current.toFixed(0)} ms, parseCsvStrict ${strict.toFixed(0)} ms (médianes de 5)`);
  assert.ok(strict < current * 3 + 50);
});
