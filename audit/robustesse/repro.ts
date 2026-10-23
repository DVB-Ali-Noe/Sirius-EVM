/**
 * Reproductions minimales des constats du rapport audit/rapports/robustesse.md.
 *
 *   TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx audit/robustesse/repro.ts ROB-01
 *
 * Sans argument : toutes les reproductions. Données synthétiques uniquement.
 */
import { parseCsv } from "@/lib/sirius/metrics";
import { inspectCsv, isNumericCell } from "@/lib/datasets/csv-check";
import type { ModelSelection } from "@/lib/models/registry";
import { ingest, LINEAR, LOGISTIC, train } from "./hostile";

const show = (label: string, value: unknown) => console.log(`  ${label.padEnd(44)} ${typeof value === "string" ? value : JSON.stringify(value)}`);

function dataset(rows: number, cell: (row: number) => string, target = (row: number) => String(row % 2)): string {
  const lines = ["x,z,y"];
  for (let row = 0; row < rows; row++) lines.push(`${cell(row)},${row % 5},${target(row)}`);
  return `${lines.join("\n")}\n`;
}

function model(text: string, selection: ModelSelection) {
  const ingestion = ingest(text, selection);
  if (ingestion.kind !== "accepted") return ingestion;
  const trained = train(text, selection);
  return trained.kind === "trained"
    ? { accepted: true, target: trained.model.target, features: trained.model.features, metrics: trained.model.metrics }
    : trained;
}

const REPROS: Record<string, () => void> = {
  "ROB-01": () => {
    show('isNumericCell(" ") / ("\\t")', [isNumericCell(" "), isNumericCell("\t")]);
    show('Number(" ")', Number(" "));
    show("même colonne avec \"\" (vide)", model(dataset(200, (r) => (r % 10 === 0 ? "" : String(r % 7))), LOGISTIC));
    show("même colonne avec \" \" (espace)", model(dataset(200, (r) => (r % 10 === 0 ? " " : String(r % 7))), LOGISTIC));
  },
  "ROB-02": () => {
    for (const cell of ["0x1A", "0b101", "0o17", " 7", "﻿5"]) show(`isNumericCell(${JSON.stringify(cell)}) → Number`, [isNumericCell(cell), Number(cell)]);
    show("identifiants 0x… pris comme variable", model(dataset(200, (r) => `0x${(r * 7919).toString(16)}`), LOGISTIC));
  },
  "ROB-03": () => {
    show('parseCsv("a,b,y\\n1,2,0\\r3,4,1\\n")', parseCsv("a,b,y\n1,2,0\r3,4,1\n"));
    show('parseCsv("a,b\\n1\\r0,2\\n")', parseCsv("a,b\n1\r0,2\n"));
    const text = dataset(200, (r) => String(r % 7), (r) => String(r)).replace("\n6,", "\r6,");
    show("régression linéaire, un \\r isolé", model(text, LINEAR));
  },
  "ROB-04": () => {
    show('parseCsv("a,b\\n1,2,3,4\\n")', parseCsv("a,b\n1,2,3,4\n"));
    const clean = dataset(200, (r) => String(r % 7), (r) => String(r * 3));
    const short = clean.replace("\n4,4,12\n", "\n4,4\n");
    show("linéaire, fichier propre", model(clean, LINEAR));
    show("linéaire, une ligne tronquée", model(short, LINEAR));
  },
  "ROB-05": () => {
    const [header] = parseCsv("﻿age,y\n1,0\n");
    show("nom de la 1re colonne avec BOM", { name: header[0], length: header[0].length, firstCode: header[0].charCodeAt(0).toString(16) });
  },
  "ROB-06": () => {
    const text = `${dataset(200, (r) => String(r % 7))}\n`;
    show("ingestion (ligne vide finale)", ingest(text, LOGISTIC));
    const check = inspectCsv(text, "logistic_regression");
    show("contrôle navigateur", check.ok ? "ok" : check.reason);
  },
};

const wanted = process.argv[2];
for (const [id, run] of Object.entries(REPROS)) {
  if (wanted && wanted !== id) continue;
  console.log(id);
  run();
}
