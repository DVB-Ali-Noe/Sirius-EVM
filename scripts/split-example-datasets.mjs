import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const datasets = [
  {
    name: "housing-prices",
    split: (rows) => rows.reduce(
      (groups, row, index) => {
        groups[index % 5 === 4 ? 1 : 0].push(row);
        return groups;
      },
      [[], []],
    ),
  },
  {
    name: "energy-demand",
    split: (rows) => {
      const boundary = Math.floor(rows.length * 0.8);
      return [rows.slice(0, boundary), rows.slice(boundary)];
    },
  },
  {
    name: "bike-sharing-demand",
    optional: true,
    split: (rows) => {
      const boundary = Math.floor(rows.length * 0.8);
      return [rows.slice(0, boundary), rows.slice(boundary)];
    },
  },
];

async function splitDataset({ name, optional, split }) {
  const source = resolve(root, `public/examples/${name}.csv`);
  let content;
  try {
    content = await readFile(source, "utf8");
  } catch (error) {
    if (optional && error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }

  const [header, ...rows] = content.trim().split(/\r?\n/);
  if (!header || rows.length < 125) throw new Error(`${name}: jeu source trop petit pour une séparation`);
  const [train, test] = split(rows);
  if (train.length < 100 || test.length < 20) throw new Error(`${name}: séparation train/test invalide`);

  await Promise.all([
    writeFile(resolve(root, `public/examples/${name}-train.csv`), `${header}\n${train.join("\n")}\n`),
    writeFile(resolve(root, `public/examples/${name}-test.csv`), `${header}\n${test.join("\n")}\n`),
  ]);
  console.log(`${name}: ${train.length} lignes train, ${test.length} lignes test`);
}

async function main() {
  for (const dataset of datasets) await splitDataset(dataset);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
