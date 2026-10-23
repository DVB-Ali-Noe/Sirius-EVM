/**
 * Mission 3 : les seuils livrés (arrondis à 3 chiffres significatifs) tombent-ils sur des valeurs
 * réellement présentes dans le fichier, et que révèlent-ils ?
 *
 *   NODE_OPTIONS=--conditions=react-server node --import tsx audit/confidentialite/thresholds.ts [--datasets ...]
 *
 * Le fichier est entraîné tel qu'un fournisseur l'enverrait (ordre d'origine ; l'enclave met de
 * côté une ligne sur cinq). Pour chaque seuil distinct (variable, t) du modèle livré :
 *   - t est-il exactement une valeur présente (sur toutes les lignes ; sur les lignes d'entraînement) ;
 *   - a = plus grande valeur < t, b = plus petite valeur ≥ t, et combien de lignes portent a et b ;
 *   - la plus rare des deux valeurs voisines est-elle portée par ≤ 5 lignes (valeur individuelle
 *     révélée à ~0,5 % près par le seuil), ou ≤ 1 ligne.
 */
import { availableDatasets, saveResults, train, walkTree, isHeldOutIndex, type Dataset } from "./lib";
import type { GradientBoostedTreesModel } from "@/lib/models/registry";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/, "").split("=");
  return [key, value ?? "true"];
}));
const DATASET_NAMES = (args.datasets ?? "taiwan,gmsc,credit-risk").split(",");

export interface ThresholdFinding {
  feature: string;
  threshold: number;
  equalsPresentAll: boolean;
  equalsPresentTrain: boolean;
  below: number;
  belowCount: number;
  above: number;
  aboveCount: number;
  rowsAtOrBelowShare: number;
}

export function analyseThresholds(dataset: Dataset, model: GradientBoostedTreesModel): ThresholdFinding[] {
  const trainRows = dataset.rows.filter((_, i) => !isHeldOutIndex(i));
  const seen = new Set<string>();
  const findings: ThresholdFinding[] = [];
  for (const tree of model.trees) {
    walkTree(tree, (node) => {
      if (!("feature" in node)) return;
      const key = `${node.feature}:${node.threshold}`;
      if (seen.has(key)) return;
      seen.add(key);
      const all = dataset.rows.map((row) => row[node.feature]);
      const trainValues = trainRows.map((row) => row[node.feature]);
      let below = Number.NEGATIVE_INFINITY;
      let above = Number.POSITIVE_INFINITY;
      for (const value of all) {
        if (value < node.threshold && value > below) below = value;
        if (value >= node.threshold && value < above) above = value;
      }
      const belowCount = all.filter((value) => value === below).length;
      const aboveCount = all.filter((value) => value === above).length;
      findings.push({
        feature: model.features[node.feature],
        threshold: node.threshold,
        equalsPresentAll: all.includes(node.threshold),
        equalsPresentTrain: trainValues.includes(node.threshold),
        below, belowCount, above, aboveCount,
        rowsAtOrBelowShare: all.filter((value) => value < node.threshold).length / all.length,
      });
    });
  }
  return findings;
}

export function summarizeThresholds(findings: ThresholdFinding[]) {
  const rareNeighbour = (limit: number) => findings.filter((f) => Math.min(f.belowCount, f.aboveCount) <= limit);
  return {
    thresholds: findings.length,
    equalsPresentAll: findings.filter((f) => f.equalsPresentAll).length,
    equalsPresentTrain: findings.filter((f) => f.equalsPresentTrain).length,
    neighbourHeldByAtMost5Rows: rareNeighbour(5).length,
    neighbourHeldBy1Row: rareNeighbour(1).length,
    rare: rareNeighbour(5).map((f) => ({ feature: f.feature, threshold: f.threshold, below: f.below, belowCount: f.belowCount, above: f.above, aboveCount: f.aboveCount, share: f.rowsAtOrBelowShare })),
  };
}

if (process.argv[1]?.endsWith("thresholds.ts")) {
  const { datasets, missing } = availableDatasets(DATASET_NAMES);
  const out: Record<string, unknown> = {};
  for (const dataset of datasets) {
    const trainIdx = dataset.rows.map((_, i) => i).filter((i) => !isHeldOutIndex(i));
    const heldIdx = dataset.rows.map((_, i) => i).filter((i) => isHeldOutIndex(i));
    const trained = train("gbdt", dataset.header, dataset.rows, trainIdx, heldIdx);
    const findings = analyseThresholds(dataset, trained.model as GradientBoostedTreesModel);
    const summary = summarizeThresholds(findings);
    out[dataset.name] = { summary, findings };
    console.log(`\n## ${dataset.name} : ${summary.thresholds} seuils distincts`);
    console.log(`- égaux à une valeur présente (toutes lignes) : ${summary.equalsPresentAll} ; (lignes d'entraînement) : ${summary.equalsPresentTrain}`);
    console.log(`- voisin le plus rare porté par ≤ 5 lignes : ${summary.neighbourHeldByAtMost5Rows} ; par 1 seule ligne : ${summary.neighbourHeldBy1Row}`);
    for (const r of summary.rare) console.log(`  - ${r.feature} < ${r.threshold} : a = ${r.below} (${r.belowCount} lignes), b = ${r.above} (${r.aboveCount} lignes), part sous le seuil ${(100 * r.share).toFixed(2)} %`);
  }
  if (missing.length) console.error(`Jeux absents : ${missing.join(", ")}`);
  console.error(`Résultats : ${saveResults("thresholds", { generatedAt: new Date().toISOString(), missing, datasets: out })}`);
}
