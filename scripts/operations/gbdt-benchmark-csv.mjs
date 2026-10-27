// CSV synthétique de mesure du profil arbres sur la CVM : 30 000 lignes, 23 variables entières,
// cible 0/1 à seuils et en U, sous la limite d'ingestion de 3 Mio. Déterministe : le modèle entraîné
// dans l'enclave doit reproduire exactement les métriques obtenues en local sur le même fichier.
// Aucune donnée réelle ni tierce.
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const BENCHMARK_ROWS = 30_000;
export const BENCHMARK_FEATURES = 23;

export function benchmarkCsv(rows = BENCHMARK_ROWS, features = BENCHMARK_FEATURES) {
  let state = 2026;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  const lines = [[...Array.from({ length: features }, (_, index) => `x${index}`), "defaulted"].join(",")];
  for (let row = 0; row < rows; row++) {
    const values = Array.from({ length: features }, () => Math.floor(next() * 100));
    const risk = -1.6 + (values[0] < 20 || values[0] > 80 ? 1.2 : 0) + (values[1] > 65 ? 0.9 : 0)
      + (values[2] < 30 && values[3] > 50 ? 1 : 0) + 0.01 * (values[4] - 50) + (next() - 0.5) * 3;
    lines.push([...values, risk > 0 ? 1 : 0].join(","));
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [destination, ...extra] = process.argv.slice(2);
    if (!destination || extra.length) throw new Error();
    const csv = benchmarkCsv();
    const fd = openSync(destination, "wx", 0o600);
    try { writeFileSync(fd, csv); fsyncSync(fd); } finally { closeSync(fd); }
    console.log(`${BENCHMARK_ROWS} lignes, ${BENCHMARK_FEATURES} variables, ${Buffer.byteLength(csv)} octets, sha256 ${createHash("sha256").update(csv).digest("hex")}`);
  } catch {
    console.error("Génération refusée : indiquer un fichier de sortie inexistant.");
    process.exitCode = 1;
  }
}
