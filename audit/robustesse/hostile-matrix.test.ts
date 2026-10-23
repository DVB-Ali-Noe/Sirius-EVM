/**
 * Matrice des fichiers hostiles demandés par l'audit, appliqués au fichier public
 * `public/examples/classification/credit-risk.csv` (13 000 lignes, cible `defaulted`).
 *
 *   TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/robustesse/hostile-matrix.test.ts
 *
 * Pour chaque mutation et chaque profil (logistique, arbres) :
 * 1. ingestion telle que `sealDatasetEnvelope` la classe (400 ou acceptée, jamais autre chose) ;
 * 2. même parcours de bout en bout : chiffrement navigateur → `sealDatasetEnvelope` (IPFS simulé,
 *    aucun appel réseau) → statut HTTP ;
 * 3. si accepté : entraînement (même code que le worker) et comparaison au modèle du fichier propre.
 *
 * Les attentes « idéales » qui ne tiennent pas aujourd'hui sont des sous-tests `todo` (ROB-xx) :
 * ils s'affichent « not ok # TODO » sans faire échouer la suite.
 */
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { AppError } from "@/lib/app-error";
import { sealDatasetEnvelope } from "@/lib/tee/core";
import { encryptDatasetForRunner } from "@/lib/tee/ingress-client";
import { datasetIngressPublicKey } from "@/lib/tee/ingress";
import type { DeliveredModel, ModelSelection } from "@/lib/models/registry";
import { publicCreditRisk } from "./datasets";
import { ingest, LINEAR, LOGISTIC, metricsFinite, train, TREES, type Ingestion, type Training } from "./hostile";

before(() => {
  process.env.TEE_MODE = "stub";
  process.env.SIRIUS_MASTER_KEY = Buffer.alloc(32, 21).toString("base64");
  process.env.PINATA_JWT = "audit-stub-sans-reseau";
  // IPFS simulé : aucun appel réseau ne sort du test.
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: { cid: "bafy-audit-stub", size: 1 } }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;
});

const CLEAN = publicCreditRisk().replace(/\n+$/, "\n");
const LINES = CLEAN.split("\n").filter(Boolean);
const [HEADER, ...BODY] = LINES;
const join = (header: string, body: string[], ending = "\n") => `${[header, ...body].join(ending)}${ending}`;
const mapCell = (column: number, map: (cell: string, row: number) => string, every = 1) =>
  join(HEADER, BODY.map((line, row) => {
    if (row % every !== 0) return line;
    const cells = line.split(",");
    cells[column] = map(cells[column], row);
    return cells.join(",");
  }));

type Ideal = "same" | "400" | "accept";
interface Mutation { id: string; label: string; csv: () => string; ideal: Ideal; finding?: string }

const MUTATIONS: Mutation[] = [
  { id: "clean", label: "fichier propre", csv: () => CLEAN, ideal: "same" },
  { id: "hex-same", label: "late_payments en hexadécimal (0x2 = 2)", csv: () => mapCell(4, (c) => `0x${Number(c).toString(16)}`), ideal: "400", finding: "ROB-02" },
  { id: "hex-id", label: "colonne d'identifiants hexadécimaux en tête (0x3fa2c1…)", csv: () => join(`client_ref,${HEADER}`, BODY.map((l, i) => `0x${((i * 2654435761) >>> 8).toString(16)},${l}`)), ideal: "accept", finding: "ROB-02" },
  { id: "spaces-pad", label: "nombres entourés d'espaces (\" 62.15 \")", csv: () => mapCell(1, (c) => ` ${c} `), ideal: "same" },
  { id: "spaces-only", label: "10 % des revenus remplacés par \" \" (valeur manquante Excel)", csv: () => mapCell(1, () => " ", 10), ideal: "400", finding: "ROB-01" },
  { id: "empty-feature", label: "une cellule vide dans income_k_eur", csv: () => mapCell(1, (c, r) => (r === 7 ? "" : c)), ideal: "accept" },
  { id: "nan", label: "NaN dans une cellule", csv: () => mapCell(1, (c, r) => (r === 7 ? "NaN" : c)), ideal: "accept" },
  { id: "infinity", label: "Infinity dans une cellule", csv: () => mapCell(1, (c, r) => (r === 7 ? "Infinity" : c)), ideal: "accept" },
  { id: "1e300", label: "1e300 dans une cellule", csv: () => mapCell(1, (c, r) => (r === 7 ? "1e300" : c)), ideal: "accept" },
  { id: "minus-zero", label: "-0 à la place de 0 (late_payments)", csv: () => mapCell(4, (c) => (c === "0" ? "-0" : c)), ideal: "same" },
  { id: "empty-target", label: "cible vide sur une ligne", csv: () => mapCell(6, (c, r) => (r === 7 ? "" : c)), ideal: "400" },
  { id: "single-class", label: "une seule classe", csv: () => mapCell(6, () => "1"), ideal: "400" },
  { id: "duplicates", label: "toutes les lignes en doublons (2 motifs)", csv: () => join(HEADER, BODY.map((_, i) => BODY[i % 2])), ideal: "accept" },
  { id: "cols-64", label: "64 colonnes (57 colonnes texte ajoutées en tête)", csv: () => join(`${Array.from({ length: 57 }, (_, i) => `t${i}`).join(",")},${HEADER}`, BODY.map((l) => `${"ab,".repeat(57)}${l}`)), ideal: "accept" },
  { id: "cols-65", label: "65 colonnes", csv: () => join(`${Array.from({ length: 58 }, (_, i) => `t${i}`).join(",")},${HEADER}`, BODY.map((l) => `${"ab,".repeat(58)}${l}`)), ideal: "400" },
  { id: "cell-10000", label: "cellule texte de 10 000 caractères", csv: () => join(`note,${HEADER}`, BODY.map((l, i) => `${i === 3 ? "x".repeat(10_000) : "n"},${l}`)), ideal: "accept" },
  { id: "cell-10001", label: "cellule texte de 10 001 caractères", csv: () => join(`note,${HEADER}`, BODY.map((l, i) => `${i === 3 ? "x".repeat(10_001) : "n"},${l}`)), ideal: "400" },
  { id: "header-128", label: "en-tête de 128 caractères", csv: () => join(`${"h".repeat(128)},${HEADER.split(",").slice(1).join(",")}`, BODY), ideal: "accept" },
  { id: "header-129", label: "en-tête de 129 caractères", csv: () => join(`${"h".repeat(129)},${HEADER.split(",").slice(1).join(",")}`, BODY), ideal: "400" },
  { id: "bom", label: "BOM UTF-8 en tête de fichier", csv: () => `﻿${CLEAN}`, ideal: "same", finding: "ROB-05" },
  { id: "crlf", label: "fins de ligne \\r\\n", csv: () => join(HEADER, BODY, "\r\n"), ideal: "same" },
  { id: "mixed-crlf", label: "\\r\\n et \\n mélangés", csv: () => [HEADER, ...BODY].map((l, i) => l + (i % 3 ? "\n" : "\r\n")).join(""), ideal: "same" },
  { id: "lone-cr", label: "un \\r isolé à la place d'un \\n (ligne 9)", csv: () => [HEADER, ...BODY].map((l, i) => l + (i === 8 ? "\r" : "\n")).join(""), ideal: "400", finding: "ROB-03" },
  { id: "lone-cr-note", label: "\\r isolé, colonne texte après la cible", csv: () => [`${HEADER},note`, ...BODY.map((l) => `${l},ok`)].map((l, i) => l + (i === 8 ? "\r" : "\n")).join(""), ideal: "400", finding: "ROB-03" },
  { id: "cr-only", label: "fichier entier en \\r (Mac classique)", csv: () => join(HEADER, BODY, "\r"), ideal: "400" },
  { id: "unclosed-mid", label: "guillemet non fermé au milieu", csv: () => mapCell(1, (c, r) => (r === 100 ? `"${c}` : c)), ideal: "400" },
  { id: "unclosed-end", label: "guillemet non fermé sur la dernière cellule", csv: () => `${CLEAN.slice(0, -2)}"${CLEAN.slice(-2)}`, ideal: "400", finding: "ROB-04" },
  { id: "trailing-comma", label: "virgule finale sur chaque ligne (8 cellules pour 7 colonnes)", csv: () => join(HEADER, BODY.map((l) => `${l},`)), ideal: "400", finding: "ROB-04" },
  { id: "decimal-comma", label: "virgule décimale non citée sur une ligne (\"62,15\")", csv: () => mapCell(1, (c, r) => (r === 7 ? c.replace(".", ",") : c)), ideal: "400", finding: "ROB-04" },
  { id: "short-row", label: "ligne tronquée (dernière cellule absente)", csv: () => join(HEADER, BODY.map((l, i) => (i === 7 ? l.slice(0, l.lastIndexOf(",")) : l))), ideal: "400", finding: "ROB-04" },
  { id: "blank-line", label: "ligne vide finale en trop", csv: () => `${CLEAN}\n`, ideal: "same", finding: "ROB-06" },
  { id: "rows-50001", label: "50 001 lignes (en-tête compris : 50 002)", csv: () => join(HEADER, Array.from({ length: 50_001 }, (_, i) => BODY[i % BODY.length])), ideal: "400" },
];

interface Outcome { ingestion: Ingestion; status: number | "crash"; training?: Training }

async function sealStatus(csv: string, selection: ModelSelection): Promise<number | "crash"> {
  const bytes = new TextEncoder().encode(csv);
  if (bytes.length > 3 * 1024 * 1024) return 413; // refusé avant chiffrement par le navigateur et `sizeBytes`
  const envelope = await encryptDatasetForRunner(bytes.buffer as ArrayBuffer, "audit-dataset", datasetIngressPublicKey());
  try {
    await sealDatasetEnvelope("audit-dataset", envelope, bytes.length, selection);
    return 200;
  } catch (error) {
    return error instanceof AppError ? error.status : "crash";
  }
}

const results = new Map<string, Outcome>();
const reference = new Map<string, DeliveredModel>();

function summary(model: DeliveredModel): string {
  const metrics = model.metrics as Record<string, number>;
  if (model.algo === "gradient_boosted_trees") return `n=${metrics.n} heldOutAuc=${metrics.heldOutAuc?.toFixed(4)} feats=${model.features.length}`;
  if (model.algo === "linear_regression") return `n=${metrics.n} cible=${model.target} r2=${metrics.r2?.toFixed(4)} feats=${model.features.length}`;
  return `n=${metrics.n} acc=${metrics.accuracy?.toFixed(4)} f1=${metrics.f1?.toFixed(4)} feats=${model.features.length}`;
}

function sameModel(left: DeliveredModel, right: DeliveredModel): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

for (const selection of [LOGISTIC, TREES, LINEAR]) {
  test(`matrice hostile — ${selection.modelId} : jamais de crash, statut HTTP = classement d'ingestion`, async () => {
    const rows: string[] = [];
    for (const mutation of MUTATIONS) {
      const csv = mutation.csv();
      const ingestion = ingest(csv, selection);
      const status = await sealStatus(csv, selection);
      const outcome: Outcome = { ingestion, status };
      assert.notEqual(ingestion.kind, "crash", `${mutation.id} : ${ingestion.kind === "crash" ? ingestion.error : ""}`);
      assert.notEqual(status, "crash", `${mutation.id} : exception non AppError au scellement`);
      if (ingestion.kind === "400") assert.equal(status, 400, `${mutation.id} : refus d'ingestion non converti en 400`);
      if (ingestion.kind === "accepted") {
        assert.equal(status, 200, `${mutation.id} : fichier accepté mais scellement en ${status}`);
        outcome.training = train(csv, selection);
        assert.equal(outcome.training.kind, "trained", `${mutation.id} : accepté puis refusé à l'entraînement`);
        if (outcome.training.kind === "trained") {
          assert.ok(metricsFinite(outcome.training.model), `${mutation.id} : métriques non finies`);
          if (mutation.id === "clean") reference.set(selection.modelId, outcome.training.model);
        }
      }
      results.set(`${selection.modelId}:${mutation.id}`, outcome);
      const clean = reference.get(selection.modelId);
      const trained = outcome.training?.kind === "trained" ? outcome.training.model : undefined;
      const verdict = ingestion.kind === "400" ? `400 « ${ingestion.message} »`
        : trained ? `${summary(trained)}${clean && mutation.id !== "clean" ? (sameModel(trained, clean) ? " (identique au propre)" : " (DIFFÉRENT du propre)") : ""}` : "?";
      rows.push(`| ${mutation.id} | ${mutation.label} | ${status} | ${verdict} | ${mutation.ideal} |`);
    }
    console.log(`\n### ${selection.modelId}\n| id | mutation | HTTP scellement | résultat | attendu idéal |\n|---|---|---|---|---|\n${rows.join("\n")}`);
  });
}

for (const mutation of MUTATIONS.filter((m) => m.finding)) {
  for (const selection of [LOGISTIC, TREES, LINEAR]) {
    test(`${mutation.finding} — ${selection.modelId} — ${mutation.label} : attendu ${mutation.ideal}`, { todo: `${mutation.finding} (comportement actuel différent)` }, () => {
      const outcome = results.get(`${selection.modelId}:${mutation.id}`);
      assert.ok(outcome);
      const clean = reference.get(selection.modelId)!;
      if (mutation.ideal === "400") assert.equal(outcome.ingestion.kind, "400");
      if (mutation.ideal === "accept") assert.ok(outcome.ingestion.kind === "accepted" || outcome.ingestion.kind === "400");
      if (mutation.ideal === "same") {
        assert.equal(outcome.training?.kind, "trained");
        if (outcome.training?.kind === "trained") assert.ok(sameModel(outcome.training.model, clean), "modèle différent du fichier propre");
      }
      if (mutation.id === "hex-id") {
        // Idéal : la colonne d'identifiants n'est pas une variable numérique.
        assert.ok(outcome.training?.kind !== "trained" || !outcome.training.model.features.includes("client_ref"), "client_ref (hexadécimal) utilisé comme variable");
      }
    });
  }
}
