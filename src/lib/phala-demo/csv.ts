import { isNumericCell } from "@/lib/datasets/csv-check";
import { qualityReport, type QualityReport } from "@/lib/datasets/quality";
import { parseCsv } from "@/lib/sirius/metrics";
import { MAX_DATASET_BYTES } from "@/lib/tee/contract";

/**
 * Le tableau tel que l'enclave le recevra : colonne choisie en dernier, les autres dans l'ordre du
 * fichier. Sert aussi au rapport de qualité, dont la cible est la dernière colonne numérique.
 * Une cellule absente (ligne trop courte) devient vide.
 */
export function tableWithTargetLast(table: string[][], target: string): string[][] {
  const header = table[0];
  const index = header?.indexOf(target) ?? -1;
  if (index < 0) return table;
  const order = [...header.keys()].filter((column) => column !== index).concat(index);
  return table.map((row) => order.map((column) => row[column] ?? ""));
}

/**
 * Rapport de qualité de `/phala`, sur le fichier tel que l'enclave le recevra (cible choisie en dernier).
 * Une cible non numérique est refusée par `csvWithTargetLast` : elle est annoncée par `invalidTarget`,
 * sans le « changement de cible » d'E1 ni une seconde mention parmi les colonnes écartées ou texte.
 */
export function demoQualityReport(table: string[][], target: string): { report: QualityReport; invalidTarget: number } | null {
  const index = table[0]?.indexOf(target) ?? -1;
  if (index < 0) return null;
  const report = qualityReport(tableWithTargetLast(table, target));
  if (!report) return null;
  const invalidTarget = table.slice(1).filter((row) => !isNumericCell(row[index] ?? "")).length;
  return {
    report: {
      ...report,
      targetShift: null,
      excluded: report.excluded.filter(({ column }) => column !== target),
      textColumns: report.textColumns.filter((column) => column !== target),
    },
    invalidTarget,
  };
}

export function csvWithTargetLast(text: string, target: string): Uint8Array<ArrayBuffer> {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header || new Set(header).size !== header.length) throw new Error("En-têtes CSV invalides");
  const index = header.indexOf(target);
  if (index < 0) throw new Error("Colonne cible absente");
  // `parseCsv` a déjà vérifié que chaque ligne a autant de cellules que l'en-tête.
  rows.forEach((row, rowIndex) => {
    // Même règle que l'enclave (`isNumericCell`) : un refus annoncé ici ne consomme pas de quota.
    if (rowIndex > 0 && !isNumericCell(row[index])) throw new Error("La colonne à prédire doit être numérique sur chaque ligne");
  });
  const quote = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const ordered = tableWithTargetLast(rows, target).map((row) => row.map(quote).join(",")).join("\n");
  const bytes = new TextEncoder().encode(ordered);
  if (!bytes.length || bytes.length > MAX_DATASET_BYTES) throw new Error("CSV vide ou trop volumineux (max 3 Mo)");
  return bytes;
}
