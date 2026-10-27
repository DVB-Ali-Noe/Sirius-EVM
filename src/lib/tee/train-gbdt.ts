import { MODEL_REGISTRY, type GradientBoostedTreesModel } from "@/lib/models/registry";
import {
  BASE_SCORE_SIG_FIGS,
  GBDT_BINS,
  GBDT_INFLUENCE_CAP,
  GBDT_L2,
  GBDT_LEARNING_RATE,
  GBDT_MAX_DEPTH,
  GBDT_MIN_LEAF_ROWS,
  GBDT_TOO_FEW_DISTINCT_ROWS_MESSAGE,
  GBDT_TREES,
  LEAF_SIG_FIGS,
  binaryAuc,
  gbdtScore,
  isHeldOut,
  roundSig,
  sigmoid,
  thresholdBetween,
  type GbdtNode,
} from "@/lib/models/gbdt";
import { DatasetValidationError, GBDT_ROW_FLOOR, assertGbdtDataset, assertWithinDeadline, trainingClockMs, trainingColumns, trainingTimeoutMs } from "./train";

/**
 * Arbres boostés stricts (profil `gradient_boosted_trees` v1.1), perte logistique, déterministes.
 *
 * - Séparation fixe : une ligne sur cinq sert aux métriques « held-out », jamais à l'entraînement.
 * - Plafond d'influence k = 1 (CONF-01, CONF-07) : parmi les lignes d'entraînement, une seule
 *   copie de chaque ligne distincte (variables + cible, comparées comme nombres) entre dans les
 *   quantiles, les gradients, les feuilles et l'audit des feuilles ; les copies suivantes sont
 *   ignorées (la première occurrence est gardée : résultat déterministe). Elles comptent dans
 *   `n`, et le fichier n'est pas modifié (Merkle root inchangé). Mesuré par l'audit : sans
 *   plafond, une ligne présente 20 fois était reconnue comme membre à AUC 0,72–0,81 ; k = 2
 *   laissait 0,55 (p = 0,01) sur GMSC ; k = 1 ramène les trois jeux au bruit (0,47–0,52) sans
 *   coût d'AUC held-out. Limite connue : des quasi-doublons (lignes distinctes à 10⁻³ près) ne
 *   sont pas plafonnés.
 * - Les seuils candidats sont, pour chaque quantile de la partie entraînement, un décimal
 *   strictement compris entre la valeur du quantile et la valeur distincte immédiatement
 *   inférieure (`thresholdBetween` : le plus court, 3 chiffres significatifs en général, 6 au
 *   plus, sinon pas de coupe). Un seuil n'est donc jamais égal à une valeur d'une ligne
 *   (CONF-03) ; il reste une statistique d'ordre : il dit qu'une valeur du fichier est juste
 *   au-dessous et une autre juste au-dessus. Le modèle livré coupe exactement où l'entraînement
 *   a coupé. Sur des valeurs à beaucoup de chiffres (années, timestamps, montants au centime),
 *   3 chiffres donnent un pas grossier et plusieurs quantiles se confondent : la variable offre
 *   peu de coupes. Recentrer ces colonnes (âge plutôt qu'année, durée plutôt que timestamp)
 *   avant publication.
 * - Les feuilles sont arrondies à leur création et c'est la valeur arrondie qui met à jour les
 *   scores : métriques et modèle livré décrivent le même objet.
 * - Une coupe exige au moins `GBDT_MIN_LEAF_ROWS` lignes d'entraînement distinctes de chaque
 *   côté ; un audit final repasse les lignes dans le modèle livré et refuse toute feuille plus
 *   petite.
 * - Ni comptes, ni gains, ni hessiens dans la sortie. Égalités départagées par la plus petite
 *   variable puis le plus petit seuil. Les métriques sont renvoyées brutes ; la porte de sortie
 *   les arrondit (3 décimales, écart d'AUC à 2 décimales, `n` à 2 chiffres).
 */
export function trainGradientBoostedTrees(csv: Buffer, target?: string): GradientBoostedTreesModel {
  const deadline = trainingClockMs() + trainingTimeoutMs();
  const { header, rows, targetIdx, featureIdx } = trainingColumns(csv, target, deadline, GBDT_ROW_FLOOR);
  assertGbdtDataset(header, rows, targetIdx, featureIdx);

  const featureCount = featureIdx.length;
  const values = new Float64Array(rows.length * featureCount);
  const labels = new Uint8Array(rows.length);
  const trainRows: number[] = [];
  const heldOutRows: number[] = [];
  const seen = new Map<string, number>();
  for (let row = 0; row < rows.length; row++) {
    if ((row & 1023) === 0) assertWithinDeadline(deadline);
    const cells = rows[row];
    for (let feature = 0; feature < featureCount; feature++) values[row * featureCount + feature] = Number(cells[featureIdx[feature]]);
    labels[row] = cells[targetIdx] === "1" ? 1 : 0;
    if (isHeldOut(row)) {
      heldOutRows.push(row);
      continue;
    }
    // Empreinte de la ligne telle que le modèle la voit (nombres, pas texte : « 1 » et « 1.0 » sont la même ligne).
    const key = `${labels[row]}|${values.subarray(row * featureCount, (row + 1) * featureCount).join(",")}`;
    const copies = (seen.get(key) ?? 0) + 1;
    seen.set(key, copies);
    if (copies <= GBDT_INFLUENCE_CAP) trainRows.push(row);
  }
  const n = trainRows.length;
  if (n < GBDT_MIN_LEAF_ROWS) throw new DatasetValidationError(GBDT_TOO_FEW_DISTINCT_ROWS_MESSAGE);

  // Seuils : quantiles de la partie entraînement (lignes distinctes), placés strictement entre deux
  // valeurs voisines du fichier entier (tranche tenue à l'écart et copies écartées comprises) : un
  // seuil n'égale jamais une valeur d'une ligne, quelle qu'elle soit. La partition des lignes
  // d'entraînement ne dépend pas de la tranche : aucune valeur d'entraînement n'est dans l'intervalle.
  const edges: number[][] = [];
  const column = new Float64Array(n);
  const fileColumn = new Float64Array(rows.length);
  for (let feature = 0; feature < featureCount; feature++) {
    assertWithinDeadline(deadline);
    for (let index = 0; index < n; index++) column[index] = values[trainRows[index] * featureCount + feature];
    column.sort();
    for (let row = 0; row < rows.length; row++) fileColumn[row] = values[row * featureCount + feature];
    fileColumn.sort();
    const featureEdges: number[] = [];
    for (let quantile = 1; quantile < GBDT_BINS; quantile++) {
      const upper = column[Math.floor((quantile * n) / GBDT_BINS)];
      // Première occurrence de `upper` dans le fichier : la valeur distincte précédente est juste avant.
      let low = 0;
      let high = fileColumn.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (fileColumn[middle] < upper) low = middle + 1;
        else high = middle;
      }
      if (low === 0) continue;
      const edge = thresholdBetween(fileColumn[low - 1], upper);
      if (edge !== null && (featureEdges.length === 0 || edge > featureEdges[featureEdges.length - 1])) featureEdges.push(edge);
    }
    edges.push(featureEdges);
  }

  // Intervalle de chaque valeur : nombre de seuils <= valeur. « x < seuil j » équivaut à « intervalle <= j ».
  const bins = new Uint8Array(n * featureCount);
  for (let index = 0; index < n; index++) {
    if ((index & 1023) === 0) assertWithinDeadline(deadline);
    for (let feature = 0; feature < featureCount; feature++) {
      const featureEdges = edges[feature];
      const value = values[trainRows[index] * featureCount + feature];
      let low = 0;
      let high = featureEdges.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (featureEdges[middle] <= value) low = middle + 1;
        else high = middle;
      }
      bins[index * featureCount + feature] = low;
    }
  }

  let positives = 0;
  for (const row of trainRows) positives += labels[row];
  const baseScore = roundSig(Math.log(positives / (n - positives)), BASE_SCORE_SIG_FIGS);
  const scores = new Float64Array(n).fill(baseScore);
  const gradients = new Float64Array(n);
  const hessians = new Float64Array(n);
  const histogramGradients = new Float64Array(featureCount * GBDT_BINS);
  const histogramHessians = new Float64Array(featureCount * GBDT_BINS);
  const histogramCounts = new Int32Array(featureCount * GBDT_BINS);

  function bestSplit(indices: Uint32Array, gradientSum: number, hessianSum: number): { feature: number; bin: number } | null {
    histogramGradients.fill(0);
    histogramHessians.fill(0);
    histogramCounts.fill(0);
    for (let position = 0; position < indices.length; position++) {
      if ((position & 2047) === 0) assertWithinDeadline(deadline);
      const index = indices[position];
      const gradient = gradients[index];
      const hessian = hessians[index];
      const offset = index * featureCount;
      for (let feature = 0; feature < featureCount; feature++) {
        const slot = feature * GBDT_BINS + bins[offset + feature];
        histogramGradients[slot] += gradient;
        histogramHessians[slot] += hessian;
        histogramCounts[slot]++;
      }
    }
    const parent = (gradientSum * gradientSum) / (hessianSum + GBDT_L2);
    let best: { feature: number; bin: number } | null = null;
    let bestGain = 0;
    for (let feature = 0; feature < featureCount; feature++) {
      let leftGradient = 0;
      let leftHessian = 0;
      let leftCount = 0;
      for (let bin = 0; bin < edges[feature].length; bin++) {
        const slot = feature * GBDT_BINS + bin;
        leftGradient += histogramGradients[slot];
        leftHessian += histogramHessians[slot];
        leftCount += histogramCounts[slot];
        if (leftCount < GBDT_MIN_LEAF_ROWS) continue;
        if (indices.length - leftCount < GBDT_MIN_LEAF_ROWS) break;
        const rightGradient = gradientSum - leftGradient;
        const gain = (leftGradient * leftGradient) / (leftHessian + GBDT_L2)
          + (rightGradient * rightGradient) / (hessianSum - leftHessian + GBDT_L2) - parent;
        if (gain > bestGain) {
          bestGain = gain;
          best = { feature, bin };
        }
      }
    }
    return best;
  }

  function grow(indices: Uint32Array, depth: number): GbdtNode {
    let gradientSum = 0;
    let hessianSum = 0;
    for (const index of indices) {
      gradientSum += gradients[index];
      hessianSum += hessians[index];
    }
    const split = depth < GBDT_MAX_DEPTH && indices.length >= 2 * GBDT_MIN_LEAF_ROWS
      ? bestSplit(indices, gradientSum, hessianSum)
      : null;
    if (split) {
      const left: number[] = [];
      const right: number[] = [];
      for (const index of indices) (bins[index * featureCount + split.feature] <= split.bin ? left : right).push(index);
      return {
        feature: split.feature,
        threshold: edges[split.feature][split.bin],
        left: grow(Uint32Array.from(left), depth + 1),
        right: grow(Uint32Array.from(right), depth + 1),
      };
    }
    const raw = (-GBDT_LEARNING_RATE * gradientSum) / (hessianSum + GBDT_L2);
    if (!Number.isFinite(raw)) throw new Error("modèle numérique instable");
    const value = roundSig(raw, LEAF_SIG_FIGS);
    for (const index of indices) scores[index] += value;
    return { value };
  }

  const root = Uint32Array.from({ length: n }, (_, index) => index);
  const trees: GbdtNode[] = [];
  for (let tree = 0; tree < GBDT_TREES; tree++) {
    assertWithinDeadline(deadline);
    for (let index = 0; index < n; index++) {
      const probability = sigmoid(scores[index]);
      gradients[index] = probability - labels[trainRows[index]];
      hessians[index] = Math.max(probability * (1 - probability), 1e-16);
    }
    trees.push(grow(root, 0));
  }

  // Audit sur le modèle livré, avec les vraies valeurs et les seuils publiés (et non les intervalles),
  // sur les lignes distinctes effectivement entraînées : une feuille doit en regrouper au moins 1 000.
  const leafCount = (node: GbdtNode): number => ("feature" in node ? leafCount(node.left) + leafCount(node.right) : 1);
  const leafCounts = new Int32Array(1 << (GBDT_MAX_DEPTH + 1));
  for (const tree of trees) {
    assertWithinDeadline(deadline);
    leafCounts.fill(0);
    for (const row of trainRows) {
      let node = tree;
      let path = 1;
      while ("feature" in node) {
        const left = values[row * featureCount + node.feature] < node.threshold;
        path = 2 * path + (left ? 0 : 1);
        node = left ? node.left : node.right;
      }
      leafCounts[path]++;
    }
    const reached = leafCounts.filter((count) => count > 0);
    if (reached.length !== leafCount(tree) || reached.some((count) => count < GBDT_MIN_LEAF_ROWS)) {
      throw new Error("audit des feuilles : feuille sous le minimum");
    }
  }

  const score = (row: number) => gbdtScore(baseScore, trees, values.subarray(row * featureCount, (row + 1) * featureCount));
  const trainAuc = binaryAuc(trainRows.map(score), trainRows.map((row) => labels[row]));
  const heldOutScores = heldOutRows.map(score);
  const heldOutLabels = heldOutRows.map((row) => labels[row]);
  const heldOutAuc = binaryAuc(heldOutScores, heldOutLabels);
  if (trainAuc === null || heldOutAuc === null) throw new Error("métriques numériques instables");

  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (let index = 0; index < heldOutScores.length; index++) {
    const predicted = sigmoid(heldOutScores[index]) >= 0.5;
    if (predicted && heldOutLabels[index] === 1) truePositive++;
    else if (predicted) falsePositive++;
    else if (heldOutLabels[index] === 1) falseNegative++;
  }
  const trueNegative = heldOutScores.length - truePositive - falsePositive - falseNegative;
  const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
  const recall = truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);

  return {
    algo: "gradient_boosted_trees",
    version: MODEL_REGISTRY.gradient_boosted_trees.version,
    target: header[targetIdx],
    features: featureIdx.map((column) => header[column]),
    baseScore,
    trees,
    metrics: {
      heldOutAuc,
      heldOutAccuracy: (truePositive + trueNegative) / heldOutScores.length,
      heldOutPrecision: precision,
      heldOutRecall: recall,
      heldOutF1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
      aucGap: trainAuc - heldOutAuc,
      n: rows.length,
    },
  };
}
