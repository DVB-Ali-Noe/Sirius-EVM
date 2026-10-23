/**
 * Écrit les CSV du parcours (Taïwan 30 000 lignes et sa coupe à 9 999 lignes) pour le niveau 2.
 * Usage : node --import tsx audit/parcours/export-taiwan.ts <dossier>
 * Données publiques OpenML 42477, contrôlées par MD5 ; aucune autre requête réseau.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { firstRows, loadAuditDataset } from "./datasets";

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error("usage : export-taiwan.ts <dossier>");
  const data = await loadAuditDataset();
  if (!data.source.startsWith("OpenML")) throw new Error(`OpenML indisponible : ${data.source}`);
  mkdirSync(out, { recursive: true });
  for (const [name, csv] of [["taiwan-30000.csv", data.csv], ["taiwan-9999.csv", firstRows(data, 9_999)]] as const) {
    writeFileSync(join(out, name), csv);
    console.log(`${name} ${csv.length} octets sha256 ${createHash("sha256").update(csv).digest("hex")}`);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
