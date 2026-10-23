/**
 * Mission 4 : que révèlent `n` exact, les métriques à 6 chiffres (`trainAuc`, held-out) et
 * `baseScore` ? Plus une attaque par différence entre deux versions d'un même fichier.
 *
 *   NODE_OPTIONS=--conditions=react-server node --import tsx audit/confidentialite/metadata.ts [--datasets taiwan] [--trials 10]
 *
 * (a) Sensibilité de `trainAuc` (6 chiffres significatifs) au retrait d'une seule ligne d'entraînement.
 * (b) Matrice de confusion held-out reconstruite à partir des cinq métriques à 6 chiffres.
 * (c) Sensibilité de `baseScore` (4 chiffres) à l'ajout de m lignes positives ou négatives.
 * (d) Différence entre versions : v1 = fichier, v2 = fichier + 20 lignes ; l'acheteur des deux
 *     modèles compare les scores de 40 candidats (20 ajoutés, 20 non) : AUC d'appartenance.
 */
import { auc, aucBootstrap, availableDatasets, fmt, isHeldOutIndex, layout, meanCi, rng, rowConfidence, saveResults, train, type Dataset } from "./lib";
import { LEAF_SIG_FIGS, binaryAuc, roundSig } from "@/lib/models/gbdt";
import type { GradientBoostedTreesModel } from "@/lib/models/registry";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/, "").split("=");
  return [key, value ?? "true"];
}));
const DATASET_NAMES = (args.datasets ?? "taiwan,gmsc").split(",");
const TRIALS = Number(args.trials ?? 10);
const SIG_FIGS = 6; // output-gate.ts

function fullFile(dataset: Dataset) {
  const trainIdx = dataset.rows.map((_, i) => i).filter((i) => !isHeldOutIndex(i));
  const heldIdx = dataset.rows.map((_, i) => i).filter((i) => isHeldOutIndex(i));
  return { trained: train("gbdt", dataset.header, dataset.rows, trainIdx, heldIdx), trainIdx, heldIdx };
}

/** (a) Combien de retraits d'une ligne changent `trainAuc` une fois arrondi à 6 chiffres ? */
export function trainAucSensitivity(dataset: Dataset, sample = 400) {
  const { trained, trainIdx } = fullFile(dataset);
  const scores = trainIdx.map((i) => trained.score(dataset.rows[i]));
  const labels = trainIdx.map((i) => dataset.rows[i].at(-1)!);
  const full = binaryAuc(scores, labels)!;
  const published = roundSig(full, SIG_FIGS);
  const random = rng(5);
  let changed = 0;
  let changed3 = 0;
  const deltas: number[] = [];
  for (let k = 0; k < sample; k++) {
    const drop = random.int(trainIdx.length);
    const s = scores.filter((_, i) => i !== drop);
    const l = labels.filter((_, i) => i !== drop);
    const without = binaryAuc(s, l)!;
    deltas.push(Math.abs(without - full));
    if (roundSig(without, SIG_FIGS) !== published) changed++;
    if (Number(without.toFixed(3)) !== Number(full.toFixed(3))) changed3++;
  }
  deltas.sort((a, b) => a - b);
  return {
    trainRows: trainIdx.length,
    publishedTrainAuc: published,
    sampledRemovals: sample,
    changesPublishedValue6SigFigs: changed / sample,
    changesValueRoundedTo3Decimals: changed3 / sample,
    medianAbsDelta: deltas[Math.floor(sample / 2)],
    maxAbsDelta: deltas[sample - 1],
    roundingStep6SigFigs: 10 ** (Math.floor(Math.log10(full)) - SIG_FIGS + 1),
  };
}

/** (b) Reconstruit (TP, FP, FN, TN) sur la tranche held-out à partir des métriques livrées. */
export function confusionFromMetrics(model: GradientBoostedTreesModel) {
  const n = model.metrics.n;
  const held = Array.from({ length: n }, (_, i) => i).filter((i) => isHeldOutIndex(i)).length;
  const m = model.metrics;
  const match = (value: number, target: number) => roundSig(value, SIG_FIGS) === target;
  const solutions: { tp: number; fp: number; fn: number; tn: number }[] = [];
  // accuracy = (tp + tn) / held → correct = tp + tn (≈ exact, pas 1 / held > 1e-6 pour held < 10⁶).
  for (let correct = 0; correct <= held; correct++) {
    if (!match(correct / held, m.heldOutAccuracy)) continue;
    for (let tp = 0; tp <= correct; tp++) {
      const tn = correct - tp;
      const wrong = held - correct;
      for (let fp = 0; fp <= wrong; fp++) {
        const fn = wrong - fp;
        const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
        const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
        if (!match(precision, m.heldOutPrecision) || !match(recall, m.heldOutRecall)) continue;
        const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
        if (!match(f1, m.heldOutF1)) continue;
        solutions.push({ tp, fp, fn, tn });
      }
    }
  }
  return { heldOutRows: held, solutions: solutions.length, first: solutions[0] ?? null, positivesHeldOut: solutions.length ? [...new Set(solutions.map((s) => s.tp + s.fn))] : [] };
}

/** (c) `baseScore` = ln(pos / neg) arrondi à 4 chiffres : à partir de combien de lignes ajoutées change-t-il ? */
export function baseScoreSensitivity(positives: number, negatives: number) {
  const base = roundSig(Math.log(positives / negatives), LEAF_SIG_FIGS);
  const firstChange = (positive: boolean) => {
    for (let m = 1; m <= 1_000; m++) {
      const value = roundSig(Math.log((positives + (positive ? m : 0)) / (negatives + (positive ? 0 : m))), LEAF_SIG_FIGS);
      if (value !== base) return m;
    }
    return null;
  };
  return { positives, negatives, baseScore: base, rowsAddedBeforeChange: { positive: firstChange(true), negative: firstChange(false) } };
}

/** (d) Attaque par différence entre deux versions livrées du même fichier. */
export function versionDifferencing(dataset: Dataset, trials: number, added = 20) {
  const aucs: number[] = [];
  const included: number[] = [];
  const excluded: number[] = [];
  let changedTrees = 0;
  let changedTreesTotal = 0;
  for (let trial = 1; trial <= trials; trial++) {
    const random = rng(trial * 31 + 17);
    const shuffled = random.shuffle(dataset.rows);
    const heldSize = Math.floor(shuffled.length / 5) + 50;
    const heldPool = shuffled.slice(0, heldSize);
    const candidates = shuffled.slice(heldSize, heldSize + 2 * added);
    const base = shuffled.slice(heldSize + 2 * added);
    const v1 = layout(base, heldPool);
    const v2 = layout([...base, ...candidates.slice(0, added)], heldPool);
    const m1 = train("gbdt", dataset.header, v1.rows, v1.trainIdx, v1.heldOutIdx);
    const m2 = train("gbdt", dataset.header, v2.rows, v2.trainIdx, v2.heldOutIdx);
    const t1 = (m1.model as GradientBoostedTreesModel).trees;
    const t2 = (m2.model as GradientBoostedTreesModel).trees;
    changedTreesTotal += t1.length;
    changedTrees += t1.filter((tree, i) => JSON.stringify(tree) !== JSON.stringify(t2[i])).length;
    const delta = candidates.map((row) => rowConfidence(m2, row) - rowConfidence(m1, row));
    const inc = delta.slice(0, added);
    const exc = delta.slice(added);
    included.push(...inc);
    excluded.push(...exc);
    aucs.push(auc(inc, exc));
    console.error(`${dataset.name} différence essai ${trial}/${trials} : AUC ${fmt(aucs.at(-1)!)}`);
  }
  const boot = aucBootstrap(included, excluded, rng(3));
  return { trials, addedPerTrial: added, perTrialAuc: meanCi(aucs), pooledAuc: boot, changedTreesShare: changedTrees / changedTreesTotal, includedPositiveShift: included.filter((d) => d > 0).length / included.length, excludedPositiveShift: excluded.filter((d) => d > 0).length / excluded.length };
}

if (process.argv[1]?.endsWith("metadata.ts")) {
  const { datasets, missing } = availableDatasets(DATASET_NAMES);
  const out: Record<string, unknown> = {};
  for (const dataset of datasets) {
    const { trained } = fullFile(dataset);
    const model = trained.model as GradientBoostedTreesModel;
    const positives = dataset.rows.filter((row, i) => !isHeldOutIndex(i) && row.at(-1) === 1).length;
    const negatives = dataset.rows.filter((row, i) => !isHeldOutIndex(i) && row.at(-1) === 0).length;
    const sensitivity = trainAucSensitivity(dataset);
    const confusion = confusionFromMetrics(model);
    const baseScore = baseScoreSensitivity(positives, negatives);
    const differencing = versionDifferencing(dataset, TRIALS);
    out[dataset.name] = { metrics: model.metrics, baseScoreDelivered: model.baseScore, sensitivity, confusion, baseScore, differencing };
    console.log(`\n## ${dataset.name}`);
    console.log(`- métriques livrées : ${JSON.stringify(model.metrics)} ; baseScore ${model.baseScore}`);
    console.log(`- (a) trainAuc : ${sensitivity.sampledRemovals} retraits d'une ligne ; la valeur publiée (6 chiffres) change dans ${fmt(100 * sensitivity.changesPublishedValue6SigFigs, 1)} % des cas, arrondie à 3 décimales dans ${fmt(100 * sensitivity.changesValueRoundedTo3Decimals, 1)} % ; |Δ| médian ${sensitivity.medianAbsDelta.toExponential(2)}, max ${sensitivity.maxAbsDelta.toExponential(2)}, pas d'arrondi ${sensitivity.roundingStep6SigFigs.toExponential(0)}`);
    console.log(`- (b) matrice de confusion held-out (${confusion.heldOutRows} lignes) : ${confusion.solutions} solution(s) compatible(s) ${JSON.stringify(confusion.first)} ; positifs held-out possibles : ${confusion.positivesHeldOut.join(", ")}`);
    console.log(`- (c) baseScore ${baseScore.baseScore} (${positives} positifs / ${negatives} négatifs) change après ${baseScore.rowsAddedBeforeChange.positive} ligne(s) positive(s) ou ${baseScore.rowsAddedBeforeChange.negative} négative(s) ajoutée(s)`);
    console.log(`- (d) différence v1/v2 (+${differencing.addedPerTrial} lignes, ${differencing.trials} essais) : AUC par essai ${fmt(differencing.perTrialAuc.mean)} [${fmt(differencing.perTrialAuc.low)}; ${fmt(differencing.perTrialAuc.high)}], groupée ${fmt(differencing.pooledAuc.auc)} [${fmt(differencing.pooledAuc.low)}; ${fmt(differencing.pooledAuc.high)}] ; arbres modifiés ${fmt(100 * differencing.changedTreesShare, 0)} % ; confiance en hausse : ajoutées ${fmt(100 * differencing.includedPositiveShift, 0)} %, non ajoutées ${fmt(100 * differencing.excludedPositiveShift, 0)} %`);
  }
  if (missing.length) console.error(`Jeux absents : ${missing.join(", ")}`);
  console.error(`Résultats : ${saveResults("metadata", { generatedAt: new Date().toISOString(), missing, datasets: out })}`);
}
