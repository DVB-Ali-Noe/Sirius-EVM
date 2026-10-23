/**
 * Banc canaris (mission 1, 5 et 6) : une ligne atypique insérée m fois dans l'entraînement
 * est-elle « retrouvée » par le modèle livré plus souvent qu'un témoin jamais vu ?
 *
 *   NODE_OPTIONS=--conditions=react-server node --import tsx audit/confidentialite/canaries.ts \
 *     [--datasets taiwan,gmsc,credit-risk] [--trainers gbdt,logistic] [--seeds 20] \
 *     [--mults 1,2,4,5,20] [--caps 1,2,4] [--canaries 20]
 *
 * Par graine : un tirage des lignes, C canaris et C témoins issus du même générateur ; puis un
 * entraînement sans canari (m = 0), un par multiplicité m, et un par plafond k à m = 20
 * (plafond simulé : au plus k copies de chaque ligne identique). Mesures sur le modèle livré :
 *   - « retrouvé » : probabilité ≥ 0,5 pour la cible 1 du canari ;
 *   - AUC d'appartenance canaris / témoins sur le score (score élevé = membre) ;
 *   - AUC d'appartenance globale par la perte (entraînement / tenu à l'écart), la mesure E2.
 * Inférence au niveau des graines (différence appariée, t de Student) : les canaris d'un même
 * entraînement ne sont pas indépendants, le test z groupé n'est donné qu'à titre descriptif.
 */
import {
  auc, aucBootstrap, aucP, availableDatasets, capDuplicates, fmt, fmtPct, layout, makeCanary, mean, meanCi, pairedT,
  rng, rowLoss, saveResults, sigmoidScoreToProbability, train, twoProportions, type Dataset, type Trainer,
} from "./lib";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/, "").split("=");
  return [key, value ?? "true"];
}));
const DATASET_NAMES = (args.datasets ?? "taiwan,gmsc,credit-risk").split(",");
const TRAINERS = (args.trainers ?? "gbdt,logistic").split(",") as Trainer[];
const SEEDS = Number(args.seeds ?? 20);
const SEED_START = Number(args.seedStart ?? 1);
const MULTS = (args.mults ?? "1,2,4,5,20").split(",").map(Number);
const CAPS = args.caps === "none" ? [] : (args.caps ?? "1,2,4").split(",").map(Number);
const CANARIES = Number(args.canaries ?? 20);
const CAP_MULT = 20;
const HELD_SLACK = 200;

interface Cell {
  trainer: Trainer;
  dataset: string;
  mult: number;
  cap: number | null;
  seeds: number;
  canaries: number;
  controls: number;
  /** Retrouvés (p ≥ 0,5) : canaris, témoins, Wilson, test z groupé (descriptif). */
  retrieved: { canary: number; control: number; canaryCi: [number, number]; controlCi: [number, number]; z: number; pPooled: number };
  /** Différence par graine (canaris − témoins), moyenne, IC t à 95 %, p apparié. */
  perSeed: { meanDiff: number; low: number; high: number; p: number };
  /** AUC canaris / témoins sur le score, bootstrap stratifié et p de Mann-Whitney. */
  scoreAuc: { auc: number; low: number; high: number; p: number };
  meanScoreShift: number;
  /**
   * Comparaison appariée au même entraînement sans canari (m = 0) : pour chaque canari, score à
   * ×m moins score à ×0 (même ligne, même graine, seule l'appartenance change) ; idem témoins
   * (effet de bord de l'insertion). Moyenne par graine, IC t, p apparié.
   */
  pairedVsBaseline: { canaryShift: { mean: number; low: number; high: number; p: number }; controlShift: { mean: number; low: number; high: number; p: number }; canaryRetrievedAt0: number; canaryNewlyRetrieved: number; canaryLost: number };
  heldOutAuc: { mean: number; low: number; high: number };
  trainMinusHeldAuc: { mean: number; low: number; high: number };
  /** Mesure E2 : AUC d'appartenance par la perte, entraînement contre tenu à l'écart. */
  membershipAuc: { mean: number; low: number; high: number };
  removedByCap: number;
  trainingMs: number;
}

interface Run {
  canaryPositive: boolean[];
  controlPositive: boolean[];
  canaryScore: number[];
  controlScore: number[];
  heldOutAuc: number;
  trainAuc: number;
  membershipAuc: number;
  removed: number;
  ms: number;
}

function membershipByLoss(trained: ReturnType<typeof train>, rows: number[][]): number {
  const memberLoss = trained.trainIdx.map((i) => -rowLoss(trained, rows[i]));
  const outLoss = trained.heldOutIdx.map((i) => -rowLoss(trained, rows[i]));
  return auc(memberLoss, outLoss);
}

function runOne(trainer: Trainer, dataset: Dataset, trainPool: number[][], heldPool: number[][], canaries: number[][], controls: number[][], mult: number, cap: number | null): Run {
  let trainRows = trainPool.slice();
  for (const canary of canaries) for (let copy = 0; copy < mult; copy++) trainRows.push(canary);
  let removed = 0;
  if (cap !== null) ({ rows: trainRows, removed } = capDuplicates(trainRows, cap));
  const placed = layout(trainRows, heldPool);
  const trained = train(trainer, dataset.header, placed.rows, placed.trainIdx, placed.heldOutIdx);
  const metrics = trained.model.metrics as { heldOutAuc?: number; trainAuc?: number };
  const members = trained.trainIdx.map((i) => placed.rows[i]);
  const outs = trained.heldOutIdx.map((i) => placed.rows[i]);
  // Pour la logistique (qui ne livre pas d'AUC), on calcule les mêmes AUC sur les mêmes lignes.
  const heldOutAuc = metrics.heldOutAuc ?? auc(outs.filter((r) => r.at(-1) === 1).map((r) => trained.score(r)), outs.filter((r) => r.at(-1) === 0).map((r) => trained.score(r)));
  const trainAuc = metrics.trainAuc ?? auc(members.filter((r) => r.at(-1) === 1).map((r) => trained.score(r)), members.filter((r) => r.at(-1) === 0).map((r) => trained.score(r)));
  return {
    canaryPositive: canaries.map((row) => sigmoidScoreToProbability(trained.score(row)) >= 0.5),
    controlPositive: controls.map((row) => sigmoidScoreToProbability(trained.score(row)) >= 0.5),
    canaryScore: canaries.map((row) => trained.score(row)),
    controlScore: controls.map((row) => trained.score(row)),
    heldOutAuc,
    trainAuc,
    membershipAuc: membershipByLoss(trained, placed.rows),
    removed,
    ms: trained.ms,
  };
}

function summarize(trainer: Trainer, dataset: string, mult: number, cap: number | null, runs: Run[], baselines: Run[]): Cell {
  const canaryShifts = runs.map((run, seed) => mean(run.canaryScore.map((s, i) => s - baselines[seed].canaryScore[i])));
  const controlShifts = runs.map((run, seed) => mean(run.controlScore.map((s, i) => s - baselines[seed].controlScore[i])));
  const canaryShiftCi = meanCi(canaryShifts);
  const controlShiftCi = meanCi(controlShifts);
  let retrievedAt0 = 0;
  let newlyRetrieved = 0;
  let lost = 0;
  runs.forEach((run, seed) => run.canaryPositive.forEach((hit, i) => {
    const before = baselines[seed].canaryPositive[i];
    if (before) retrievedAt0++;
    if (hit && !before) newlyRetrieved++;
    if (!hit && before) lost++;
  }));
  const canaryHits = runs.reduce((sum, run) => sum + run.canaryPositive.filter(Boolean).length, 0);
  const controlHits = runs.reduce((sum, run) => sum + run.controlPositive.filter(Boolean).length, 0);
  const canaryCount = runs.reduce((sum, run) => sum + run.canaryPositive.length, 0);
  const controlCount = runs.reduce((sum, run) => sum + run.controlPositive.length, 0);
  const canaryCi = wilsonPair(canaryHits, canaryCount);
  const controlCi = wilsonPair(controlHits, controlCount);
  const pooled = twoProportions(canaryHits, canaryCount, controlHits, controlCount);
  const diffs = runs.map((run) => run.canaryPositive.filter(Boolean).length / run.canaryPositive.length - run.controlPositive.filter(Boolean).length / run.controlPositive.length);
  const diffCi = meanCi(diffs);
  const paired = pairedT(diffs);
  const canaryScores = runs.flatMap((run) => run.canaryScore);
  const controlScores = runs.flatMap((run) => run.controlScore);
  const boot = aucBootstrap(canaryScores, controlScores, rng(99));
  const heldOut = meanCi(runs.map((run) => run.heldOutAuc));
  const gap = meanCi(runs.map((run) => run.trainAuc - run.heldOutAuc));
  const membership = meanCi(runs.map((run) => run.membershipAuc));
  return {
    trainer, dataset, mult, cap, seeds: runs.length, canaries: canaryCount, controls: controlCount,
    retrieved: { canary: canaryHits / canaryCount, control: controlHits / controlCount, canaryCi, controlCi, z: pooled.z, pPooled: pooled.p },
    perSeed: { meanDiff: diffCi.mean, low: diffCi.low, high: diffCi.high, p: paired.p },
    scoreAuc: { auc: boot.auc, low: boot.low, high: boot.high, p: aucP(boot.auc, canaryScores.length, controlScores.length) },
    meanScoreShift: canaryScores.reduce((s, v) => s + v, 0) / canaryScores.length - controlScores.reduce((s, v) => s + v, 0) / controlScores.length,
    pairedVsBaseline: {
      canaryShift: { mean: canaryShiftCi.mean, low: canaryShiftCi.low, high: canaryShiftCi.high, p: pairedT(canaryShifts).p },
      controlShift: { mean: controlShiftCi.mean, low: controlShiftCi.low, high: controlShiftCi.high, p: pairedT(controlShifts).p },
      canaryRetrievedAt0: retrievedAt0 / canaryCount,
      canaryNewlyRetrieved: newlyRetrieved / canaryCount,
      canaryLost: lost / canaryCount,
    },
    heldOutAuc: { mean: heldOut.mean, low: heldOut.low, high: heldOut.high },
    trainMinusHeldAuc: { mean: gap.mean, low: gap.low, high: gap.high },
    membershipAuc: { mean: membership.mean, low: membership.low, high: membership.high },
    removedByCap: runs.reduce((sum, run) => sum + run.removed, 0) / runs.length,
    trainingMs: runs.reduce((sum, run) => sum + run.ms, 0) / runs.length,
  };
}

function wilsonPair(k: number, n: number): [number, number] {
  const z = 1.96;
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [centre - half, centre + half];
}

function label(cell: Cell): string {
  return cell.cap === null ? `×${cell.mult}` : `×${cell.mult}, k ≤ ${cell.cap}`;
}

function printTable(cells: Cell[]): void {
  console.log("| Modèle | Jeu | Cas | Retrouvés canaris [IC 95 %] | Retrouvés témoins [IC 95 %] | Diff. par graine [IC] | p apparié | AUC score canaris/témoins [IC] | p | Décalage de score vs ×0 : canaris [IC] (p) | témoins [IC] | AUC held-out | train − held | AUC appartenance (perte) |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of cells) {
    const b = c.pairedVsBaseline;
    console.log(`| ${c.trainer} | ${c.dataset} | ${label(c)} | ${fmtPct(c.retrieved.canary)} [${fmtPct(c.retrieved.canaryCi[0])}; ${fmtPct(c.retrieved.canaryCi[1])}] | ${fmtPct(c.retrieved.control)} [${fmtPct(c.retrieved.controlCi[0])}; ${fmtPct(c.retrieved.controlCi[1])}] | ${fmtPct(c.perSeed.meanDiff)} [${fmtPct(c.perSeed.low)}; ${fmtPct(c.perSeed.high)}] | ${fmt(c.perSeed.p, 4)} | ${fmt(c.scoreAuc.auc)} [${fmt(c.scoreAuc.low)}; ${fmt(c.scoreAuc.high)}] | ${fmt(c.scoreAuc.p, 4)} | ${fmt(b.canaryShift.mean, 4)} [${fmt(b.canaryShift.low, 4)}; ${fmt(b.canaryShift.high, 4)}] (${fmt(b.canaryShift.p, 4)}) | ${fmt(b.controlShift.mean, 4)} [${fmt(b.controlShift.low, 4)}; ${fmt(b.controlShift.high, 4)}] | ${fmt(c.heldOutAuc.mean)} | ${fmt(c.trainMinusHeldAuc.mean, 4)} | ${fmt(c.membershipAuc.mean, 4)} [${fmt(c.membershipAuc.low, 4)}; ${fmt(c.membershipAuc.high, 4)}] |`);
  }
}

export function runCanaries(options: { datasets: string[]; trainers: Trainer[]; seeds: number; seedStart?: number; mults: number[]; caps: number[]; canaries: number; quiet?: boolean }): { cells: Cell[]; missing: string[] } {
  const seedStart = options.seedStart ?? 1;
  const { datasets, missing } = availableDatasets(options.datasets);
  const cells: Cell[] = [];
  for (const dataset of datasets) {
    for (const trainer of options.trainers) {
      const byCase = new Map<string, Run[]>();
      const push = (key: string, run: Run) => byCase.set(key, [...(byCase.get(key) ?? []), run]);
      for (let seed = seedStart; seed < seedStart + options.seeds; seed++) {
        const random = rng(seed * 7919 + dataset.name.length);
        const shuffled = random.shuffle(dataset.rows);
        const heldSize = Math.floor(shuffled.length / 5) + HELD_SLACK;
        const heldPool = shuffled.slice(0, heldSize);
        const trainPool = shuffled.slice(heldSize);
        const canaries = Array.from({ length: options.canaries }, () => makeCanary(dataset, trainPool, random));
        const controls = Array.from({ length: options.canaries }, () => makeCanary(dataset, trainPool, random));
        const started = performance.now();
        push("0|null", runOne(trainer, dataset, trainPool, heldPool, canaries, controls, 0, null));
        for (const mult of options.mults) push(`${mult}|null`, runOne(trainer, dataset, trainPool, heldPool, canaries, controls, mult, null));
        for (const cap of options.caps) push(`${CAP_MULT}|${cap}`, runOne(trainer, dataset, trainPool, heldPool, canaries, controls, CAP_MULT, cap));
        if (!options.quiet) console.error(`${dataset.name}/${trainer} graine ${seed}/${seedStart + options.seeds - 1} : ${((performance.now() - started) / 1000).toFixed(1)} s`);
      }
      const baselines = byCase.get("0|null")!;
      for (const [key, runs] of byCase) {
        const [mult, cap] = key.split("|");
        cells.push(summarize(trainer, dataset.name, Number(mult), cap === "null" ? null : Number(cap), runs, baselines));
      }
    }
  }
  return { cells, missing };
}

if (process.argv[1]?.endsWith("canaries.ts")) {
  const { cells, missing } = runCanaries({ datasets: DATASET_NAMES, trainers: TRAINERS, seeds: SEEDS, seedStart: SEED_START, mults: MULTS, caps: CAPS, canaries: CANARIES });
  if (missing.length) console.error(`Jeux absents (lancer fetch-openml.mjs) : ${missing.join(", ")}`);
  printTable(cells);
  const path = saveResults(`canaries${args.tag ? `-${args.tag}` : ""}`, { generatedAt: new Date().toISOString(), seeds: SEEDS, seedStart: SEED_START, canariesPerSeed: CANARIES, mults: MULTS, caps: CAPS, missing, cells });
  console.error(`Résultats : ${path}`);
}
