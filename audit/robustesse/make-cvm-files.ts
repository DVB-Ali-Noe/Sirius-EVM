/**
 * Écrit les CSV de mesure CVM (procédure du rapport audit/rapports/robustesse.md, § mémoire et temps).
 * Données publiques répétées (credit-risk.csv) ou synthétiques à graine fixe : rien de réel.
 *
 *   node --import tsx audit/robustesse/make-cvm-files.ts <dossier-de-sortie>
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { denseTwoChar, escapedQuoteBomb, publicCreditRisk } from "./datasets";

const out = process.argv[2];
if (!out) throw new Error("Dossier de sortie requis");
mkdirSync(out, { recursive: true });
const [header, ...body] = publicCreditRisk().split("\n").filter(Boolean);
const repeat = (rows: number) => `${[header, ...Array.from({ length: rows }, (_, i) => body[i % body.length])].join("\n")}\n`;
const files: Record<string, string> = {
  "credit-risk-10k.csv": repeat(10_000),
  "credit-risk-30k.csv": repeat(30_000),
  "credit-risk-49999.csv": repeat(49_999),
  "dense-49999x20.csv": denseTwoChar(49_999, 20),
  "dense-30000x32.csv": denseTwoChar(30_000, 32),
  "quote-bomb-140.csv": escapedQuoteBomb(140, 9_999),
};
for (const [name, text] of Object.entries(files)) {
  writeFileSync(join(out, name), text);
  console.log(`${name}\t${Buffer.byteLength(text)} octets\tsha256 ${createHash("sha256").update(text).digest("hex")}`);
}
