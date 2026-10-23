/**
 * Données publiques du parcours d'audit.
 *
 * Source principale : OpenML 42477 « default-of-credit-card-clients » (Taïwan, 30 000 lignes,
 * 23 variables x1..x23, cible y en 0/1). Le fichier ARFF est téléchargé une seule fois, contrôlé
 * par son MD5 publié par OpenML, puis mis en cache dans le dossier temporaire du système.
 * La colonne `id` est retirée : c'est un numéro de ligne, pas une variable.
 *
 * Repli si OpenML est injoignable : `public/examples/classification/credit-risk.csv`
 * (13 000 lignes, déjà dans le dépôt).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const OPENML_TAIWAN_URL = "https://openml.org/data/v1/download/21854402/default-of-credit-card-clients.arff";
export const OPENML_TAIWAN_MD5 = "4efbcc48d388c8cff428950006198b4e";

export interface AuditDataset {
  source: string;
  csv: Buffer;
  header: string[];
  rows: number;
}

function parseTaiwanArff(arff: string): AuditDataset {
  const lines = arff.split(/\r?\n/);
  const attributes = lines.filter((line) => /^@attribute/i.test(line)).map((line) => line.split(/\s+/)[1]);
  const start = lines.findIndex((line) => /^@data/i.test(line.trim()));
  if (attributes[0] !== "id" || attributes.at(-1) !== "y" || start < 0) throw new Error("ARFF Taïwan inattendu");
  const header = attributes.slice(1);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const values = line.split(",");
    if (values.length !== attributes.length) throw new Error("ligne ARFF inattendue");
    body.push(values.slice(1).join(","));
  }
  return { source: "OpenML 42477 (Taïwan, default of credit card clients)", header, rows: body.length,
    csv: Buffer.from(`${header.join(",")}\n${body.join("\n")}\n`) };
}

function creditRiskFallback(reason: string): AuditDataset {
  const csv = readFileSync(resolve("public/examples/classification/credit-risk.csv"));
  const lines = csv.toString("utf8").trim().split(/\r?\n/);
  return { source: `public/examples/classification/credit-risk.csv (repli : ${reason})`, header: lines[0].split(","), rows: lines.length - 1, csv };
}

/** Télécharge (une fois) puis renvoie le jeu Taïwan ; replie sur credit-risk si OpenML échoue. */
export async function loadAuditDataset(fetchImpl: typeof fetch = fetch): Promise<AuditDataset> {
  if (process.env.SIRIUS_AUDIT_DATASET === "credit-risk") return creditRiskFallback("demandé par SIRIUS_AUDIT_DATASET");
  const cache = join(tmpdir(), "sirius-audit-openml-42477.arff");
  try {
    let bytes: Buffer;
    if (existsSync(cache)) bytes = readFileSync(cache);
    else {
      const response = await fetchImpl(OPENML_TAIWAN_URL, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`OpenML ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    const md5 = createHash("md5").update(bytes).digest("hex");
    if (md5 !== OPENML_TAIWAN_MD5) throw new Error(`MD5 OpenML inattendu ${md5}`);
    if (!existsSync(cache)) writeFileSync(cache, bytes);
    return parseTaiwanArff(bytes.toString("utf8"));
  } catch (error) {
    return creditRiskFallback((error as Error).message);
  }
}

/** Garde l'en-tête et les `rows` premières lignes. */
export function firstRows(dataset: AuditDataset, rows: number): Buffer {
  const lines = dataset.csv.toString("utf8").trim().split(/\r?\n/);
  return Buffer.from(`${lines.slice(0, rows + 1).join("\n")}\n`);
}
