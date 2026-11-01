/**
 * Parseur CSV et règle numérique stricts, partagés par le navigateur, l'ingestion et l'enclave
 * (audit robustesse ROB-01 à ROB-06, exactitude EXA-03 et EXA-04). Cas repris de
 * `audit/robustesse/strict-csv.test.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { test } from "node:test";
import { inspectCsv, csvRejectionText } from "@/lib/datasets/csv-check";
import { translateEnglish } from "@/lib/i18n/english";
import { selectionForModelId, type ModelId } from "@/lib/models/registry";
import { trainGradientBoostedTrees } from "@/lib/tee/train-gbdt";
import { trainLinearRegression, trainLogisticRegression, validateTrainingDataset } from "@/lib/tee/train";
import { CsvValidationError, isNumericCell, MAX_CSV_ROWS, parseCsv, type CsvSyntaxProblem } from "./metrics";

const CREDIT_RISK = readFileSync(joinPath(process.cwd(), "public/examples/classification/credit-risk.csv"), "utf8");
// Fins de ligne normalisées : la copie de travail peut être en CRLF (core.autocrlf).
const CLEAN = CREDIT_RISK.replaceAll("\r\n", "\n").replace(/\n+$/, "\n");
const [HEADER, ...BODY] = CLEAN.split("\n").filter(Boolean);
const lines = (header: string, body: string[], ending = "\n") => `${[header, ...body].join(ending)}${ending}`;
const mapCell = (column: number, map: (cell: string, row: number) => string) =>
  lines(HEADER, BODY.map((line, row) => {
    const cells = line.split(",");
    cells[column] = map(cells[column], row);
    return cells.join(",");
  }));

/** Refus du parseur avec son défaut typé (le navigateur s'en sert pour un message précis). */
function problemOf(text: string): CsvSyntaxProblem | undefined {
  try {
    parseCsv(text);
  } catch (error) {
    assert.ok(error instanceof CsvValidationError, String(error));
    return error.problem;
  }
  assert.fail("fichier accepté");
}

test("fichiers valides : même tableau qu'avant le durcissement (RFC 4180, CRLF, guillemets)", () => {
  assert.deepEqual(parseCsv('a,"b,c",d\n1,"x""y",2\n3,"multi\nligne",4\n'), [["a", "b,c", "d"], ["1", 'x"y', "2"], ["3", "multi\nligne", "4"]]);
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]], "sans fin de ligne finale");
  assert.deepEqual(parseCsv('a,b\n"",2\n,3\n'), [["a", "b"], ["", "2"], ["", "3"]], "cellules vides");
  assert.deepEqual(parseCsv('a,b\n1,"\r"\n'), [["a", "b"], ["1", "\r"]], "\\r entre guillemets : contenu de la cellule");
  assert.deepEqual(parseCsv(""), []);
  const table = parseCsv(CREDIT_RISK);
  assert.equal(table.length, 13_001);
  assert.ok(table.every((row) => row.length === table[0].length));
});

test("EXA-04 / ROB-05 : un BOM UTF-8 initial est retiré, le nom de la première colonne reste propre", () => {
  assert.deepEqual(parseCsv(`﻿${CLEAN}`), parseCsv(CLEAN));
  assert.equal(parseCsv("﻿age,y\n1,0\n")[0][0], "age");
  // Le modèle de l'enclave porte les mêmes noms que l'évaluation du navigateur (qui lit sans BOM).
  const regression = "x,y\n" + Array.from({ length: 150 }, (_, row) => `${row},${row * 2 + (row % 3)}`).join("\n");
  assert.deepEqual(trainLinearRegression(Buffer.from(`﻿${regression}`)), trainLinearRegression(Buffer.from(regression)));
  // Un BOM ailleurs qu'au début reste un caractère ordinaire.
  assert.equal(parseCsv("a,﻿b\n1,2")[0][1], "﻿b");
});

test("ROB-06 : lignes vides finales ignorées, ligne vide avant la fin refusée", () => {
  const expected = parseCsv(CLEAN);
  assert.deepEqual(parseCsv(`${CLEAN}\n\n`), expected);
  assert.deepEqual(parseCsv(`${CLEAN.replaceAll("\n", "\r\n")}\r\n`), expected);
  assert.deepEqual(parseCsv([HEADER, ...BODY].map((line, row) => line + (row % 3 ? "\n" : "\r\n")).join("")), expected, "\\n et \\r\\n mélangés");
  assert.deepEqual(problemOf(lines(HEADER, [...BODY.slice(0, 10), "", ...BODY.slice(10)])), { kind: "blank-line", line: 12 });
  assert.deepEqual(problemOf("\na,b\n1,2\n"), { kind: "blank-line", line: 1 });
  // Les lignes vides finales ne comptent pas dans la limite de lignes.
  assert.equal(parseCsv(`${"x\n".repeat(MAX_CSV_ROWS)}\n\n`).length, MAX_CSV_ROWS);
});

test("ROB-03 : un \\r isolé est refusé au lieu de coller deux lignes", () => {
  assert.deepEqual(problemOf("a,b,y\n1,2,0\r3,4,1\n"), { kind: "lone-cr", line: 2 });
  assert.deepEqual(problemOf([HEADER, ...BODY].map((line, row) => line + (row === 8 ? "\r" : "\n")).join("")), { kind: "lone-cr", line: 9 });
  assert.deepEqual(problemOf(mapCell(1, (cell, row) => (row === 3 ? cell.replace(".", "\r") : cell))), { kind: "lone-cr", line: 5 });
  assert.deepEqual(problemOf(lines(HEADER, BODY, "\r")), { kind: "lone-cr", line: 1 }, "fichier en fins de ligne Mac classiques");
});

test("ROB-04 : chaque ligne a autant de cellules que l'en-tête", () => {
  const columns = HEADER.split(",").length;
  assert.deepEqual(problemOf(mapCell(1, (cell, row) => (row === 7 ? cell.replace(".", ",") : cell))), { kind: "cell-count", line: 9, cells: columns + 1, columns }, "virgule décimale non citée");
  assert.deepEqual(problemOf(lines(HEADER, BODY.map((line, row) => (row === 7 ? line.slice(0, line.lastIndexOf(",")) : line)))), { kind: "cell-count", line: 9, cells: columns - 1, columns }, "ligne tronquée");
  assert.deepEqual(problemOf(lines(HEADER, BODY.map((line) => `${line},`))), { kind: "cell-count", line: 2, cells: columns + 1, columns }, "virgule finale");
  assert.deepEqual(problemOf("a,b\n1,2\n   \n"), { kind: "cell-count", line: 3, cells: 1, columns: 2 }, "ligne d'espaces");
  // Le numéro est celui de la ligne où commence l'enregistrement, même après une cellule sur plusieurs lignes.
  assert.deepEqual(problemOf('a,b\n"x\ny",1\n2\n'), { kind: "cell-count", line: 4, cells: 1, columns: 2 });
});

test("ROB-04 : guillemets hors RFC 4180 refusés", () => {
  assert.deepEqual(problemOf(mapCell(1, (cell, row) => (row === 5 ? `6"2` : cell))), { kind: "quote-in-field", line: 7 });
  assert.deepEqual(problemOf('a,b\n1"2,3"4\n'), { kind: "quote-in-field", line: 2 });
  assert.deepEqual(problemOf('a,b\n1, "x"\n'), { kind: "quote-in-field", line: 2 }, "espace avant le guillemet : lu autrement selon les outils");
  assert.deepEqual(problemOf('a,b\n"x"y,1\n'), { kind: "after-quote", line: 2 });
  assert.deepEqual(problemOf(mapCell(1, (cell, row) => (row === 100 ? `"${cell}` : cell))), { kind: "unclosed-quote", line: 102 });
  assert.deepEqual(problemOf(`${CLEAN.slice(0, -2)}"${CLEAN.slice(-2)}`), { kind: "unclosed-quote", line: 13_001 });
});

test("fuzz : le parseur ne lève que CsvValidationError et ne rend que des lignes de même longueur", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  const alphabet = ["a", "1", ",", '"', "\n", "\r", "\r\n", " ", "﻿", "x".repeat(4_000), ",".repeat(70), "\n\n"];
  for (let run = 0; run < 20_000; run++) {
    let text = "";
    for (let i = Math.floor(random() * 50); i > 0; i--) text += alphabet[Math.floor(random() * alphabet.length)];
    try {
      const table = parseCsv(text);
      assert.ok(table.every((row) => row.length === table[0].length), JSON.stringify(text));
    } catch (error) {
      assert.ok(error instanceof CsvValidationError, String(error));
    }
  }
});

test("navigateur et enclave refusent le même fichier, avec la ligne fautive dans les deux messages", () => {
  const cases: Array<[string, CsvSyntaxProblem["kind"], RegExp, RegExp]> = [
    ["a,b,y\n1,2,0\r3,4,1\n", "lone-cr", /^Ligne 2 : retour chariot isolé/, /^Invalid CSV at line 2: lone carriage return/],
    ["a,b,y\n1,2\n", "cell-count", /^Ligne 2 : 2 cellule\(s\) pour 3 colonne\(s\)/, /^Invalid CSV at line 2: 2 cell\(s\) for 3 column\(s\)/],
    ['a,b,y\n1,"2,0\n', "unclosed-quote", /^Ligne 2 : guillemet ouvert jamais fermé/, /^Invalid CSV at line 2: quote never closed/],
    ["a,b,y\n\n1,2,0\n", "blank-line", /^Ligne 2 : ligne vide/, /^Invalid CSV at line 2: blank line/],
    ['a,b,y\n1,2"",0\n', "quote-in-field", /^Ligne 2 : guillemet au milieu/, /^Invalid CSV at line 2: quote in the middle/],
    ['a,b,y\n1,"2"0,0\n', "after-quote", /^Ligne 2 : caractère après un guillemet fermant/, /^Invalid CSV at line 2: character after a closing quote/],
  ];
  for (const [text, kind, browserText, enclaveEnglish] of cases) {
    for (const modelId of ["linear_regression", "logistic_regression", "gradient_boosted_trees"] as ModelId[]) {
      const browser = inspectCsv(text, modelId);
      assert.ok(!browser.ok && browser.reason.kind === "malformed" && browser.reason.problem.kind === kind, `${kind} ${modelId}`);
      assert.match(csvRejectionText(browser.reason, (key, values) => key.replace(/\{(\w+)\}/g, (_, name) => String(values?.[name]))), browserText);
      assert.match(csvRejectionText(browser.reason, translateEnglish), /^Line 2: /);
      assert.throws(() => validateTrainingDataset(Buffer.from(text), selectionForModelId(modelId)), (error: unknown) => {
        assert.ok(error instanceof CsvValidationError);
        assert.match(translateEnglish(error.message), enclaveEnglish);
        return true;
      });
    }
  }
});

test("ROB-01 / ROB-02 : isNumericCell n'accepte que l'écriture décimale d'un tableur", () => {
  const accepted = ["0", "-0", "+1", "1.5", ".5", "5.", "1e3", "-2.5E-4", "1e12", "-1e12", "1000000000000", "007", " 5", "5 ", "\t5\t", "1e-400"];
  const refused = [
    "", " ", "  ", "\t", "0x1A", "0X1a", "0b101", "0o17", "NaN", "Infinity", "-Infinity", "1e300", "1000000000001",
    "1_000", "1,5", "1 000", "﻿5", " 7", "5 ", "\n5", "1e12.5", "--1", "e5", ".", "+", "1e", "١",
  ];
  for (const cell of accepted) assert.equal(isNumericCell(cell), true, JSON.stringify(cell));
  for (const cell of refused) assert.equal(isNumericCell(cell), false, JSON.stringify(cell));
  // Une cellule acceptée garde exactement la valeur que lisait `Number()` : aucun modèle valide ne change.
  for (const cell of accepted) assert.ok(Number.isFinite(Number(cell)));
});

/** Fichier de régression 0/1 assez grand pour les trois profils, avec une colonne remplaçable en tête. */
function binaryFile(first: (row: number) => string, rows = 10_000): string {
  const lines = ["first,a,b,y"];
  for (let row = 0; row < rows; row++) {
    const a = (row * 37) % 101;
    const b = (row * 53) % 97;
    lines.push(`${first(row)},${a},${b},${(a + b + (row % 7) * 9) % 100 < 45 ? 1 : 0}`);
  }
  return `${lines.join("\n")}\n`;
}

test("ROB-02 : un identifiant hexadécimal n'est plus une variable, dans aucun profil", () => {
  const hex = Buffer.from(binaryFile((row) => `0x${((row * 2_654_435_761) >>> 8).toString(16)}`));
  const without = Buffer.from(binaryFile(() => "ref"));
  for (const train of [trainLinearRegression, trainLogisticRegression, trainGradientBoostedTrees]) {
    const model = train(hex);
    assert.deepEqual(model.features, ["a", "b"]);
    assert.deepEqual(model, train(without), "même modèle que si la colonne était du texte");
  }
});

test("ROB-01 : une cellule d'espaces compte comme vide (colonne écartée), plus comme un 0", () => {
  const spaces = Buffer.from(binaryFile((row) => (row % 10 === 0 ? " " : String(row % 13))));
  const empty = Buffer.from(binaryFile((row) => (row % 10 === 0 ? "" : String(row % 13))));
  for (const train of [trainLinearRegression, trainLogisticRegression, trainGradientBoostedTrees]) {
    const model = train(spaces);
    assert.ok(!model.features.includes("first"));
    assert.deepEqual(model, train(empty));
  }
  // Le navigateur décrit la même colonne écartée et la même cible que l'enclave.
  const browser = inspectCsv(spaces.toString(), "gradient_boosted_trees");
  assert.ok(browser.ok);
  assert.deepEqual(browser.summary.features, ["a", "b"]);
});

test("des espaces autour d'un nombre ne changent rien : même modèle qu'avec les nombres nus", () => {
  const bare = binaryFile((row) => String(row % 13));
  const padded = bare.split("\n").map((line, row) => (row === 0 || !line ? line : line.split(",").map((cell, column) => (column < 3 ? ` ${cell}\t` : cell)).join(","))).join("\n");
  for (const train of [trainLinearRegression, trainLogisticRegression, trainGradientBoostedTrees]) {
    assert.deepEqual(train(Buffer.from(padded)), train(Buffer.from(bare)));
  }
});

test("EXA-03 : cible incomplète refusée à l'ingestion par les trois profils, même motif dans le navigateur", () => {
  // Une cellule vide dans la cible faisait prendre `b` pour cible ; les arbres refusaient avec un motif trompeur.
  const text = binaryFile((row) => String(row % 13)).replace(/,(\d)\n/, ",\n");
  for (const modelId of ["linear_regression", "logistic_regression", "gradient_boosted_trees"] as ModelId[]) {
    const browser = inspectCsv(text, modelId);
    assert.ok(!browser.ok);
    assert.deepEqual(browser.reason, { kind: "incomplete-target", target: "y", missing: 1, invalid: 0 }, modelId);
    assert.equal(
      csvRejectionText(browser.reason, translateEnglish),
      "The last column, “y”, is the target but contains 1 empty and 0 non-numeric cell(s). Fill them in, or put the column to predict last.",
    );
    assert.throws(() => validateTrainingDataset(Buffer.from(text), selectionForModelId(modelId)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(translateEnglish(error.message), "The last column “y” is the target but is not fully numeric (1 empty cell(s), 0 non-numeric)");
      return true;
    });
  }
  // Une dernière colonne de texte reste admise : la cible est la dernière colonne numérique, comme avant.
  const withNote = binaryFile((row) => String(row % 13)).replace("first,a,b,y\n", "first,a,b,y,note\n").replace(/(\d)\n/g, "$1,texte\n");
  assert.ok(inspectCsv(withNote, "gradient_boosted_trees").ok);
  assert.doesNotThrow(() => validateTrainingDataset(Buffer.from(withNote), selectionForModelId("gradient_boosted_trees")));
});
