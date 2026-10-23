// Télécharge les deux jeux publics de l'audit (OpenML 42477 Taïwan, OpenML 46929 Give Me Some
// Credit) et les convertit en CSV « prêts pour Sirius » (cible 0/1 en dernière colonne).
// Sortie : audit/confidentialite/data/*.csv (dossier ignoré par git). Aucune dépendance.
//
//   node audit/confidentialite/fetch-openml.mjs
//
// GMSC : 150 000 lignes dépassent le plafond CSV de Sirius (50 000) ; on garde les lignes
// complètes (sans « ? ») puis un sous-échantillon déterministe de 30 000 lignes (LCG, graine 1).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, "data");

const SOURCES = {
  taiwan: {
    meta: "https://www.openml.org/api/v1/json/data/42477",
    target: "y",
    drop: ["id"],
    rename: { y: "default" },
    sample: null,
  },
  gmsc: {
    meta: "https://www.openml.org/api/v1/json/data/46929",
    target: "FinancialDistressNextTwoYears",
    drop: [],
    rename: {},
    sample: 30_000,
  },
};

function parseArff(text) {
  const attributes = [];
  const rows = [];
  let inData = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line || line.startsWith("%")) continue;
    if (!inData) {
      const match = /^@attribute\s+(\S+|'[^']+')\s+(.+)$/i.exec(line);
      if (match) attributes.push({ name: match[1].replace(/^'|'$/g, ""), type: match[2].trim() });
      else if (/^@data/i.test(line)) inData = true;
      continue;
    }
    rows.push(line.split(",").map((cell) => cell.trim().replace(/^'|'$/g, "")));
  }
  return { attributes, rows };
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

async function build(name, source) {
  const meta = await (await fetch(source.meta)).json();
  const url = meta.data_set_description.url;
  const arff = await (await fetch(url)).text();
  const { attributes, rows } = parseArff(arff);
  const names = attributes.map((attribute) => attribute.name);
  const targetIdx = names.indexOf(source.target);
  if (targetIdx < 0) throw new Error(`${name} : cible ${source.target} absente`);
  const nominal = attributes[targetIdx].type.startsWith("{") ? attributes[targetIdx].type.replace(/[{}\s]/g, "").split(",") : null;
  const keep = names.map((column, index) => index).filter((index) => index !== targetIdx && !source.drop.includes(names[index]));
  const header = [...keep.map((index) => source.rename[names[index]] ?? names[index]), source.rename[source.target] ?? source.target];

  let complete = rows.filter((row) => row.length === names.length && row.every((cell) => cell !== "?" && cell !== ""));
  const dropped = rows.length - complete.length;
  if (source.sample && complete.length > source.sample) {
    const next = lcg(1);
    for (let i = complete.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [complete[i], complete[j]] = [complete[j], complete[i]];
    }
    complete = complete.slice(0, source.sample);
  }
  const lines = complete.map((row) => {
    const label = nominal ? String(nominal.indexOf(row[targetIdx])) : String(Number(row[targetIdx]));
    if (label !== "0" && label !== "1") throw new Error(`${name} : cible non binaire ${row[targetIdx]}`);
    return [...keep.map((index) => String(Number(row[index]))), label].join(",");
  });
  await mkdir(dataDir, { recursive: true });
  const output = resolve(dataDir, `${name}.csv`);
  await writeFile(output, `${header.join(",")}\n${lines.join("\n")}\n`);
  console.log(`${name}: ${lines.length} lignes, ${header.length - 1} variables, ${dropped} lignes incomplètes écartées → ${output}`);
}

for (const [name, source] of Object.entries(SOURCES)) await build(name, source);
