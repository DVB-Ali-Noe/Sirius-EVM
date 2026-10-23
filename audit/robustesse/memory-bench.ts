/**
 * Mesure locale mémoire / temps du worker d'entraînement (src/lib/tee/bounded-training.ts).
 *
 * Usage (depuis la racine du dépôt) :
 *   TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx audit/robustesse/memory-bench.ts
 *
 * Pour chaque cas :
 * - `minOldGenMb` : plus petite limite `maxOldGenerationSizeMb` (même worker, même code que
 *   `trainInWorker`, young gen 16 Mo) pour laquelle l'entraînement aboutit ; la production impose 128.
 * - `workerMs` : durée de `trainInWorker` réel (limite 128 Mo, démarrage tsx du worker compris).
 * - `trainMs` : durée de l'entraînement seul, dans le processus courant.
 * - `validateMs` / `validateHeapMb` : contrôle d'ingestion `validateTrainingDataset` (processus runner).
 */
import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cpus, totalmem } from "node:os";
import { trainInWorker } from "@/lib/tee/bounded-training";
import { validateTrainingDataset } from "@/lib/tee/train";
import { trainSelectedModel } from "@/lib/tee/model-registry";
import type { ModelSelection } from "@/lib/models/registry";
import { denseTwoChar, escapedQuoteBomb, publicCreditRisk, syntheticBinary } from "./datasets";

const LOGISTIC: ModelSelection = { modelId: "logistic_regression", modelVersion: "1.0.0" };
const TREES: ModelSelection = { modelId: "gradient_boosted_trees", modelVersion: "1.0.0" };

type Outcome = "ok" | "oom" | "invalid" | "exit" | "timeout";

function runWorker(selection: ModelSelection, csv: Buffer, oldMb: number): Promise<Outcome> {
  return new Promise((done) => {
    const worker = new Worker("require('tsx/cjs'); require(require('node:worker_threads').workerData.module);", {
      eval: true, execArgv: ["--conditions=react-server"],
      workerData: { module: resolve(process.cwd(), "src/lib/tee/train-worker.ts"), selection, csv },
      resourceLimits: { maxOldGenerationSizeMb: oldMb, maxYoungGenerationSizeMb: 16 },
    });
    let settled = false;
    const finish = (outcome: Outcome) => { if (!settled) { settled = true; void worker.terminate(); done(outcome); } };
    const timer = setTimeout(() => finish("timeout"), 60_000);
    worker.once("message", (message: { invalidDataset?: boolean }) => { clearTimeout(timer); finish(message.invalidDataset ? "invalid" : "ok"); });
    worker.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); finish(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "oom" : "exit"); });
    worker.once("exit", () => { clearTimeout(timer); finish("exit"); });
  });
}

async function minimumOldGen(selection: ModelSelection, csv: Buffer): Promise<string> {
  const seen: string[] = [];
  for (const mb of [16, 24, 32, 48, 64, 96, 128]) {
    const outcome = await runWorker(selection, csv, mb);
    if (outcome === "ok") return String(mb);
    seen.push(`${mb}:${outcome}`);
  }
  return `aucune (${seen.join(" ")})`;
}

const REPS = Number(process.env.BENCH_REPS ?? 3);
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return `${sorted[0]} / ${sorted[Math.floor(sorted.length / 2)]}`;
};

function rowsOf(text: string): string {
  const lines = text.split("\n");
  return lines.slice(0, 1).concat(lines.slice(1).filter(Boolean)).join("\n");
}

function repeatPublic(rows: number): string {
  const [header, ...body] = rowsOf(publicCreditRisk()).split("\n");
  const out = [header];
  for (let i = 0; i < rows; i++) out.push(body[i % body.length]);
  return `${out.join("\n")}\n`;
}

const cases: Array<{ name: string; selection: ModelSelection; csv: () => string }> = [
  { name: "démarrage du worker seul (100 lignes)", selection: LOGISTIC, csv: () => repeatPublic(100) },
  { name: "logistique 10k × 7 (credit-risk public, répété)", selection: LOGISTIC, csv: () => repeatPublic(10_000) },
  { name: "logistique 30k × 7 (credit-risk public, répété)", selection: LOGISTIC, csv: () => repeatPublic(30_000) },
  { name: "logistique 50k × 7 (credit-risk public, répété)", selection: LOGISTIC, csv: () => repeatPublic(49_999) },
  { name: "arbres 10k × 7 (credit-risk public, répété)", selection: TREES, csv: () => repeatPublic(10_000) },
  { name: "arbres 30k × 7 (credit-risk public, répété)", selection: TREES, csv: () => repeatPublic(30_000) },
  { name: "arbres 50k × 7 (credit-risk public, répété)", selection: TREES, csv: () => repeatPublic(49_999) },
  { name: "logistique 50k × 20 (cellules 2 car., pire cas budget)", selection: LOGISTIC, csv: () => denseTwoChar(49_999, 20) },
  { name: "logistique 16k × 64 (32 num. + 32 texte, 2 car.)", selection: LOGISTIC, csv: () => denseTwoChar(16_000, 32, 32) },
  { name: "arbres 30k × 32 (31 variables, plafond d'opérations)", selection: TREES, csv: () => denseTwoChar(30_000, 32) },
  { name: "arbres 32k × 24 synthétique (décimales)", selection: TREES, csv: () => syntheticBinary(32_000, 23, 7, 1) },
  { name: "logistique bombe guillemets 140 × 10k car.", selection: LOGISTIC, csv: () => escapedQuoteBomb(140, 9_999) },
  // Fichier mesuré sur la CVM le 20 octobre (docs/PHALA-DEMO-IMPLEMENTATION.md) : même générateur.
  { name: "arbres 30k × 23 (gbdt-benchmark-csv.mjs, mesuré sur CVM le 20/10)", selection: TREES, csv: () => cvmBenchmark },
];
let cvmBenchmark = "";

async function main() {
  const generator = await import(pathToFileURL(resolve(process.cwd(), "scripts/operations/gbdt-benchmark-csv.mjs")).href) as { benchmarkCsv: () => string };
  cvmBenchmark = generator.benchmarkCsv();
  console.log(`# machine : ${cpus()[0]?.model ?? "?"} × ${cpus().length}, RAM ${Math.round(totalmem() / 2 ** 30)} Gio, Node ${process.version}`);
  console.log(`| cas | octets | validation | validateMs | validateHeapMb | trainMs min / médiane (${REPS} essais) | workerMs min / médiane (128 Mo, délai 15 s) | issues worker | minOldGenMb |`);
  console.log("|---|---|---|---|---|---|---|---|---|");
  const only = process.env.BENCH_ONLY ? new RegExp(process.env.BENCH_ONLY) : null;
  for (const { name, selection, csv: build } of cases.filter((item) => !only || only.test(item.name))) {
    const csv = Buffer.from(build());
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const v0 = performance.now();
    let validation = "acceptée";
    try { validateTrainingDataset(csv, selection); } catch (error) { validation = `refus : ${(error as Error).message}`; }
    const validateMs = Math.round(performance.now() - v0);
    const validateHeapMb = Math.round((process.memoryUsage().heapUsed - heapBefore) / 2 ** 20);
    let trainMs = "-";
    if (validation === "acceptée") {
      const times: number[] = [];
      for (let rep = 0; rep < REPS; rep++) {
        const t0 = performance.now();
        try { trainSelectedModel(selection, csv); times.push(Math.round(performance.now() - t0)); } catch (error) { trainMs = `échec : ${(error as Error).message}`; break; }
      }
      if (times.length) trainMs = stats(times);
    }
    const workerTimes: number[] = [];
    const outcomes = new Set<string>();
    for (let rep = 0; rep < REPS; rep++) {
      const w0 = performance.now();
      try { await trainInWorker(selection, csv, AbortSignal.timeout(15_000)); outcomes.add("ok"); }
      catch (error) { outcomes.add(`${(error as Error).name} ${(error as { status?: number }).status ?? ""}`); }
      workerTimes.push(Math.round(performance.now() - w0));
    }
    const workerMs = stats(workerTimes);
    const workerOutcome = [...outcomes].join(", ");
    const minOld = validation === "acceptée" ? await minimumOldGen(selection, csv) : null;
    console.log(`| ${name} | ${csv.length} | ${validation} | ${validateMs} | ${validateHeapMb} | ${trainMs} | ${workerMs} | ${workerOutcome} | ${minOld ?? "-"} |`);
  }
}

void main();
