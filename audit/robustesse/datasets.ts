/**
 * Générateurs de CSV pour l'audit de robustesse : uniquement des données synthétiques
 * (PRNG à graine fixe) ou le fichier public `public/examples/classification/credit-risk.csv`.
 * Aucune donnée réelle d'utilisateur.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Toujours en fins de ligne `\n` (une copie Windows avec `core.autocrlf` le lit en `\r\n`). */
export function publicCreditRisk(): string {
  return readFileSync(resolve(process.cwd(), "public/examples/classification/credit-risk.csv"), "utf-8").replace(/\r\n/g, "\n");
}

/** Classification binaire synthétique : `features` colonnes, cible 0/1 dépendant des deux premières. */
export function syntheticBinary(rows: number, features: number, seed = 1, decimals = 2): string {
  const random = prng(seed);
  const header = [...Array.from({ length: features }, (_, i) => `x${i}`), "y"];
  const lines = [header.join(",")];
  for (let row = 0; row < rows; row++) {
    const values = Array.from({ length: features }, () => random() * 10);
    const score = values[0] - (values[1] ?? 5) + (random() - 0.5) * 4;
    lines.push([...values.map((v) => v.toFixed(decimals)), score > 0 ? "1" : "0"].join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** Cellules de deux caractères (« 10 » à « 99 ») : le pire rapport cellules / octets hors cache V8 des chaînes d'un caractère. */
export function denseTwoChar(rows: number, numeric: number, text = 0, seed = 2): string {
  const random = prng(seed);
  const header = [
    ...Array.from({ length: text }, (_, i) => `t${i}`),
    ...Array.from({ length: numeric - 1 }, (_, i) => `x${i}`),
    "y",
  ];
  const lines = [header.join(",")];
  for (let row = 0; row < rows; row++) {
    const cells: string[] = [];
    for (let i = 0; i < text; i++) cells.push(String.fromCharCode(97 + Math.floor(random() * 26), 97 + Math.floor(random() * 26)));
    let first = 0;
    for (let i = 0; i < numeric - 1; i++) {
      const v = 10 + Math.floor(random() * 90);
      if (i === 0) first = v;
      cells.push(String(v));
    }
    cells.push(first + (random() - 0.5) * 30 > 55 ? "1" : "0");
    lines.push(cells.join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** Bombe de guillemets échappés : chaque cellule texte est faite de `pairs` séquences `""`. */
export function escapedQuoteBomb(rows: number, pairs: number): string {
  const cell = `"${'""'.repeat(pairs)}"`;
  const lines = ["x,t,y"];
  for (let i = 0; i < rows; i++) lines.push(`${i % 7},${cell},${i % 2}`);
  return `${lines.join("\n")}\n`;
}
