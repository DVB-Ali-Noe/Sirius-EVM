/**
 * Attaque d'appartenance (mission 2 et 5) sur le modèle livré, lignes ordinaires (pas de canari).
 *
 *   NODE_OPTIONS=--conditions=react-server node --import tsx audit/confidentialite/membership.ts \
 *     [--datasets taiwan,gmsc,credit-risk] [--trainers gbdt,logistic] [--seeds 10] [--shadows 16]
 *
 * Par graine : la moitié des lignes sert de membres (entraînement, avec la tranche une-sur-cinq de
 * l'enclave prise dans l'autre moitié), l'autre moitié de non-membres. Deux attaques :
 *   1. perte : score = − perte logistique de la ligne sous le modèle livré (Yeom et al., 2018) ;
 *   2. LiRA hors ligne (Carlini et al., 2022) : S modèles fantômes entraînés sur des moitiés
 *      aléatoires ; pour chaque ligne, la distribution « non-membre » de sa confiance logit est
 *      estimée sur les fantômes qui ne l'ont pas vue ; score = écart réduit (variance globale).
 * Sorties : AUC (bootstrap stratifié par graine, IC t entre graines), TPR à 1 % et 0,1 % de FPR.
 * Plus la mesure E2 telle que l'enclave la calculerait : AUC des pertes entraînement / tenu à l'écart.
 */
import { auc, aucBootstrap, availableDatasets, fmt, layout, meanCi, mean, rng, rowConfidence, rowLoss, saveResults, sd, tprAtFpr, train, type Dataset, type Trainer } from "./lib";
import { GBDT_MIN_ROWS } from "@/lib/models/gbdt";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/, "").split("=");
  return [key, value ?? "true"];
}));
const DATASET_NAMES = (args.datasets ?? "taiwan,gmsc,credit-risk").split(",");
const TRAINERS = (args.trainers ?? "gbdt,logistic").split(",") as Trainer[];
const SEEDS = Number(args.seeds ?? 10);
const SEED_START = Number(args.seedStart ?? 1);
const SHADOWS = Number(args.shadows ?? 16);

interface SeedResult {
  seed: number;
  members: number;
  nonMembers: number;
  lossAuc: number;
  lossAucCi: [number, number];
  lossTpr1: number;
  lossTpr01: number;
  liraAuc: number;
  liraAucCi: [number, number];
  liraTpr1: number;
  liraTpr01: number;
  e2MembershipAuc: number;
  heldOutAuc: number;
  trainAuc: number;
  ms: number;
}

/** Entraîne sur une moitié aléatoire : renvoie le modèle et l'appartenance de chaque ligne du jeu. */
function halfSplit(dataset: Dataset, random: ReturnType<typeof rng>, trainer: Trainer) {
  const order = random.shuffle(dataset.rows.map((_, i) => i));
  // Moitié des lignes, ou le plancher du profil arbres (10 000 lignes d'entraînement) si le jeu
  // est trop petit : les lignes mises à l'écart par l'enclave et les lignes restantes sont toutes
  // des non-membres (jamais vues par l'entraînement).
  const half = Math.max(Math.floor(dataset.rows.length / 2), trainer === "gbdt" ? GBDT_MIN_ROWS : 0);
  const heldSize = Math.floor(half / 4) + 1;
  if (half + heldSize > dataset.rows.length) throw new Error(`${dataset.name} : trop petit pour l'attaque d'appartenance (${trainer})`);
  const memberIds = order.slice(0, half);
  const heldIds = order.slice(half, half + heldSize);
  const placed = layout(memberIds.map((i) => dataset.rows[i]), heldIds.map((i) => dataset.rows[i]));
  const trained = train(trainer, dataset.header, placed.rows, placed.trainIdx, placed.heldOutIdx);
  const isMember = new Uint8Array(dataset.rows.length);
  for (const i of memberIds) isMember[i] = 1;
  return { trained, isMember, placed };
}

export function runMembership(options: { datasets: string[]; trainers: Trainer[]; seeds: number; seedStart?: number; shadows: number; quiet?: boolean }) {
  const seedStart = options.seedStart ?? 1;
  const { datasets, missing } = availableDatasets(options.datasets);
  const results: { trainer: Trainer; dataset: string; seeds: SeedResult[]; summary: Record<string, { mean: number; low: number; high: number }> }[] = [];
  for (const dataset of datasets) {
    for (const trainer of options.trainers) {
      const seeds: SeedResult[] = [];
      for (let seed = seedStart; seed < seedStart + options.seeds; seed++) {
        const started = performance.now();
        const random = rng(seed * 104_729 + dataset.name.length);
        const target = halfSplit(dataset, random, trainer);
        const rows = dataset.rows;
        const confidence = rows.map((row) => rowConfidence(target.trained, row));
        const lossScore = rows.map((row) => -rowLoss(target.trained, row));
        const members = rows.map((_, i) => i).filter((i) => target.isMember[i] === 1);
        const nonMembers = rows.map((_, i) => i).filter((i) => target.isMember[i] === 0);

        // Fantômes : mêmes réglages, moitiés indépendantes.
        const outSum = new Float64Array(rows.length);
        const outSq = new Float64Array(rows.length);
        const outCount = new Uint16Array(rows.length);
        for (let s = 0; s < options.shadows; s++) {
          const shadow = halfSplit(dataset, rng(seed * 104_729 + 7_000_000 + s * 613 + dataset.name.length), trainer);
          for (let i = 0; i < rows.length; i++) {
            if (shadow.isMember[i]) continue;
            const c = rowConfidence(shadow.trained, rows[i]);
            outSum[i] += c;
            outSq[i] += c * c;
            outCount[i]++;
          }
        }
        // Variance globale des résidus (variante « variance fixe » de LiRA, plus stable avec peu de fantômes).
        let residualSq = 0;
        let residualCount = 0;
        const outMean = new Float64Array(rows.length);
        for (let i = 0; i < rows.length; i++) {
          if (outCount[i] === 0) { outMean[i] = Number.NaN; continue; }
          outMean[i] = outSum[i] / outCount[i];
          residualSq += outSq[i] - outCount[i] * outMean[i] * outMean[i];
          residualCount += outCount[i] - 1;
        }
        const sigma = Math.sqrt(residualSq / Math.max(residualCount, 1)) || 1;
        const lira = rows.map((_, i) => (Number.isNaN(outMean[i]) ? 0 : (confidence[i] - outMean[i]) / sigma));

        const pick = (scores: number[], ids: number[]) => ids.map((i) => scores[i]);
        const lossBoot = aucBootstrap(pick(lossScore, members), pick(lossScore, nonMembers), rng(seed), 200);
        const liraBoot = aucBootstrap(pick(lira, members), pick(lira, nonMembers), rng(seed + 1), 200);
        const metrics = target.trained.model.metrics as { heldOutAuc?: number; trainAuc?: number };
        const e2 = auc(target.trained.trainIdx.map((i) => -rowLoss(target.trained, target.placed.rows[i])), target.trained.heldOutIdx.map((i) => -rowLoss(target.trained, target.placed.rows[i])));
        seeds.push({
          seed, members: members.length, nonMembers: nonMembers.length,
          lossAuc: lossBoot.auc, lossAucCi: [lossBoot.low, lossBoot.high],
          lossTpr1: tprAtFpr(pick(lossScore, members), pick(lossScore, nonMembers), 0.01),
          lossTpr01: tprAtFpr(pick(lossScore, members), pick(lossScore, nonMembers), 0.001),
          liraAuc: liraBoot.auc, liraAucCi: [liraBoot.low, liraBoot.high],
          liraTpr1: tprAtFpr(pick(lira, members), pick(lira, nonMembers), 0.01),
          liraTpr01: tprAtFpr(pick(lira, members), pick(lira, nonMembers), 0.001),
          e2MembershipAuc: e2,
          heldOutAuc: metrics.heldOutAuc ?? Number.NaN,
          trainAuc: metrics.trainAuc ?? Number.NaN,
          ms: performance.now() - started,
        });
        if (!options.quiet) console.error(`${dataset.name}/${trainer} graine ${seed}/${seedStart + options.seeds - 1} : perte ${fmt(lossBoot.auc)} LiRA ${fmt(liraBoot.auc)} (${((performance.now() - started) / 1000).toFixed(0)} s)`);
      }
      const summary = {
        lossAuc: meanCi(seeds.map((s) => s.lossAuc)),
        liraAuc: meanCi(seeds.map((s) => s.liraAuc)),
        lossTpr1: meanCi(seeds.map((s) => s.lossTpr1)),
        liraTpr1: meanCi(seeds.map((s) => s.liraTpr1)),
        liraTpr01: meanCi(seeds.map((s) => s.liraTpr01)),
        e2MembershipAuc: meanCi(seeds.map((s) => s.e2MembershipAuc)),
        heldOutAuc: meanCi(seeds.map((s) => s.heldOutAuc)),
        trainMinusHeldAuc: meanCi(seeds.map((s) => s.trainAuc - s.heldOutAuc)),
      };
      results.push({ trainer, dataset: dataset.name, seeds, summary });
    }
  }
  return { results, missing };
}

if (process.argv[1]?.endsWith("membership.ts")) {
  const { results, missing } = runMembership({ datasets: DATASET_NAMES, trainers: TRAINERS, seeds: SEEDS, seedStart: SEED_START, shadows: SHADOWS });
  if (missing.length) console.error(`Jeux absents : ${missing.join(", ")}`);
  console.log("| Modèle | Jeu | Graines | Membres / non-membres | AUC perte [IC t] | AUC LiRA [IC t] | TPR@1 % FPR (perte / LiRA) | TPR@0,1 % (LiRA) | AUC E2 (perte, train / écart) | AUC held-out | train − held |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const s = r.summary;
    console.log(`| ${r.trainer} | ${r.dataset} | ${r.seeds.length} | ${r.seeds[0].members} / ${r.seeds[0].nonMembers} | ${fmt(s.lossAuc.mean, 4)} [${fmt(s.lossAuc.low, 4)}; ${fmt(s.lossAuc.high, 4)}] | ${fmt(s.liraAuc.mean, 4)} [${fmt(s.liraAuc.low, 4)}; ${fmt(s.liraAuc.high, 4)}] | ${fmt(s.lossTpr1.mean, 4)} / ${fmt(s.liraTpr1.mean, 4)} | ${fmt(s.liraTpr01.mean, 4)} | ${fmt(s.e2MembershipAuc.mean, 4)} [${fmt(s.e2MembershipAuc.low, 4)}; ${fmt(s.e2MembershipAuc.high, 4)}] | ${fmt(s.heldOutAuc.mean, 4)} | ${fmt(s.trainMinusHeldAuc.mean, 4)} [${fmt(s.trainMinusHeldAuc.low, 4)}; ${fmt(s.trainMinusHeldAuc.high, 4)}] |`);
  }
  const path = saveResults(`membership${args.tag ? `-${args.tag}` : ""}`, { generatedAt: new Date().toISOString(), seeds: SEEDS, seedStart: SEED_START, shadows: SHADOWS, missing, results });
  console.error(`Résultats : ${path}`);
}

export { mean, sd };
