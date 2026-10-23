/**
 * Fuzz du parseur CSV et du contrôle d'ingestion de l'enclave (audit robustesse, ROB-xx).
 *
 *   NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/robustesse/csv-fuzz.test.ts
 *
 * Graine et volume réglables : AUDIT_SEED (défaut 20261023), AUDIT_FUZZ_RUNS (défaut 600).
 * Générateur maison à graine fixe (pas de dépendance ajoutée) ; données 100 % synthétiques.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CsvValidationError, MAX_CSV_COLUMNS, MAX_CSV_ROWS, parseCsv } from "@/lib/sirius/metrics";
import { inspectCsv } from "@/lib/datasets/csv-check";
import { prng } from "./datasets";
import { hostileCsv, ingest, LINEAR, LOGISTIC, metricsFinite, randomShape, train } from "./hostile";

const SEED = Number(process.env.AUDIT_SEED ?? 20261023);
const RUNS = Number(process.env.AUDIT_FUZZ_RUNS ?? 600);

test("parseCsv : 20 000 entrées aléatoires ne lèvent que CsvValidationError et respectent les plafonds", () => {
  const random = prng(SEED);
  const alphabet = ["a", "1", "0", ".", "-", ",", ",", '"', '"', "\n", "\r", "\r\n", " ", "﻿", "x".repeat(4_000), ",".repeat(70), "\n".repeat(3)];
  let rejected = 0;
  for (let run = 0; run < 20_000; run++) {
    let text = "";
    const length = Math.floor(random() * 60);
    for (let i = 0; i < length; i++) text += alphabet[Math.floor(random() * alphabet.length)];
    try {
      const table = parseCsv(text);
      assert.ok(table.length <= MAX_CSV_ROWS);
      for (const row of table) {
        assert.ok(row.length <= MAX_CSV_COLUMNS, "ligne au-delà de 64 colonnes");
        for (const cell of row) assert.ok(cell.length <= 10_000, "cellule au-delà de 10 000 caractères");
      }
    } catch (error) {
      assert.ok(error instanceof CsvValidationError, `exception inattendue : ${(error as Error)?.constructor?.name} ${(error as Error)?.message}`);
      rejected++;
    }
  }
  console.log(`[fuzz parseur] 20000 entrées, ${rejected} refus CsvValidationError, 0 autre exception`);
});

test("ingestion + entraînement : aucun crash sur des fichiers hostiles générés (logistique, linéaire)", () => {
  const counters = { files: 0, accepted: 0, rejected: 0, crashes: [] as string[], trainFailures: [] as string[], nonFinite: 0, wrongN: 0, browserStricter: [] as string[], browserLooser: 0 };
  const random = prng(SEED + 1);
  for (let run = 0; run < RUNS; run++) {
    // Une moitié très hostile, une moitié « presque valide » pour atteindre l'entraînement.
    const shape = randomShape(random, run % 2 === 1);
    const csv = hostileCsv(shape, SEED + run);
    counters.files++;
    for (const selection of [LOGISTIC, LINEAR]) {
      const ingestion = ingest(csv, selection);
      const browser = inspectCsv(csv, selection.modelId);
      if (ingestion.kind === "crash") { counters.crashes.push(`${run}:${selection.modelId}:${ingestion.error}`); continue; }
      if (!browser.ok && ingestion.kind === "accepted") counters.browserStricter.push(`${run}:${selection.modelId}:${browser.reason.kind}`);
      if (browser.ok && ingestion.kind === "400") counters.browserLooser++;
      if (ingestion.kind === "400") { counters.rejected++; continue; }
      counters.accepted++;
      const trained = train(csv, selection);
      if (trained.kind === "failed") { counters.trainFailures.push(`${run}:${selection.modelId}:${trained.error}:${JSON.stringify(shape)}`); continue; }
      if (!metricsFinite(trained.model)) counters.nonFinite++;
      if ((trained.model.metrics as { n?: number }).n !== ingestion.rowCount) counters.wrongN++;
    }
  }
  console.log(`[fuzz ingestion] ${counters.files} fichiers × 2 modèles : ${counters.accepted} acceptés, ${counters.rejected} refus 400, ` +
    `${counters.crashes.length} crash, ${counters.trainFailures.length} échecs d'entraînement après acceptation, ` +
    `${counters.nonFinite} métriques non finies, ${counters.wrongN} n faux, navigateur plus strict que l'enclave : ${counters.browserStricter.length}, ` +
    `navigateur plus laxiste : ${counters.browserLooser}`);
  for (const failure of counters.trainFailures.slice(0, 5)) console.log(`  échec après acceptation : ${failure}`);
  assert.deepEqual(counters.crashes, [], "un fichier hostile ne doit jamais produire autre chose qu'un 400 à l'ingestion");
  // Un fichier accepté puis refusé à l'entraînement serait une 422 après paiement de l'emprunteur.
  assert.deepEqual(counters.trainFailures, []);
  assert.equal(counters.nonFinite, 0);
  assert.equal(counters.wrongN, 0);
  // csv-check.ts promet : « un fichier refusé ici l'aurait été par l'enclave ».
  assert.deepEqual(counters.browserStricter, []);
});

