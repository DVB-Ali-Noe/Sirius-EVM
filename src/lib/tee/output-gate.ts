import "server-only";
import {
  BASE_SCORE_SIG_FIGS,
  GBDT_AUC_GAP_DECIMALS,
  GBDT_METRIC_DECIMALS,
  GBDT_ROW_COUNT_SIG_FIGS,
  GBDT_TREES,
  LEAF_SIG_FIGS,
  THRESHOLD_MAX_SIG_FIGS,
  isGbdtNode,
  roundDecimals,
  roundSig,
  type GbdtNode,
} from "@/lib/models/gbdt";
import type { TrainedModel } from "./train";

// Output-gate (D-18) : borne ce qui peut sortir du calcul confidentiel. Le canal
// d'exfiltration d'un pipeline d'entraînement (même en TEE) = les poids du modèle,
// où un code malveillant peut encoder la donnée brute (mémorisation, stéga LSB).
const SIG_FIGS = 6; // précision retenue des poids → borne la capacité d'un canal caché (~20 bits/coef)
const MAX_MODEL_BYTES = 256 * 1024; // plafond de la sortie → borne l'info totale exfiltrable
// Plafond générique de largeur de sortie de l'output-gate (≠ MAX_FEATURES de l'algo courant,
// autre couche) : borne l'allocation avant sérialisation quel que soit le producteur.
const MAX_COEFFICIENTS = 10_000;

/**
 * Arbres : seuils à 6 chiffres au plus (l'entraînement publie le décimal le plus court strictement
 * entre deux valeurs voisines, 3 chiffres en général : la grille livrée est celle de
 * l'entraînement, donc sans effet sur les feuilles auditées), feuilles à 4 chiffres. Nœuds
 * reconstruits champ par champ : aucun compte, gain ou hessien ne peut sortir, même si un
 * producteur en ajoutait.
 */
function quantizeNode(node: GbdtNode): GbdtNode {
  return "feature" in node
    ? { feature: node.feature, threshold: roundSig(node.threshold, THRESHOLD_MAX_SIG_FIGS), left: quantizeNode(node.left), right: quantizeNode(node.right) }
    : { value: roundSig(node.value, LEAF_SIG_FIGS) };
}

/**
 * Quantifie poids et métriques, et reconstruit une struct canonique : champs listés
 * explicitement (ordre fixe → sérialisation déterministe + whitelist, aucun champ libre
 * où cacher un canal annexe). Un modèle déjà quantifié repasse à l'identique (idempotent).
 *
 * Arbres (profil 1.1.0, E2 minimale) : métriques held-out à 3 décimales (à 6 chiffres, elles
 * donnaient la matrice de confusion exacte de la tranche), écart d'AUC à 2 décimales (le
 * `trainAuc` à 6 chiffres changeait au retrait d'une seule ligne dans 97 % des cas), `n` à
 * 2 chiffres significatifs (le compte exact identifiait le fichier et chiffrait les ajouts
 * entre deux versions). Linéaire et logistique v1 gardent leur format (D-27).
 */
export function quantizeModel<T extends TrainedModel>(model: T): T {
  if (model.algo === "gradient_boosted_trees") {
    return {
      algo: model.algo,
      version: model.version,
      target: model.target,
      features: model.features,
      baseScore: roundSig(model.baseScore, BASE_SCORE_SIG_FIGS),
      trees: model.trees.map(quantizeNode),
      metrics: {
        heldOutAuc: roundDecimals(model.metrics.heldOutAuc, GBDT_METRIC_DECIMALS),
        heldOutAccuracy: roundDecimals(model.metrics.heldOutAccuracy, GBDT_METRIC_DECIMALS),
        heldOutPrecision: roundDecimals(model.metrics.heldOutPrecision, GBDT_METRIC_DECIMALS),
        heldOutRecall: roundDecimals(model.metrics.heldOutRecall, GBDT_METRIC_DECIMALS),
        heldOutF1: roundDecimals(model.metrics.heldOutF1, GBDT_METRIC_DECIMALS),
        aucGap: roundDecimals(model.metrics.aucGap, GBDT_AUC_GAP_DECIMALS),
        n: roundSig(model.metrics.n, GBDT_ROW_COUNT_SIG_FIGS),
      },
    } as T;
  }
  const base = {
    algo: model.algo,
    version: model.version,
    target: model.target,
    features: model.features,
    coefficients: model.coefficients.map((coefficient) => roundSig(coefficient, SIG_FIGS)),
  };
  if (model.algo === "linear_regression") {
    return {
      ...base,
      algo: "linear_regression",
      metrics: {
        r2: roundSig(model.metrics.r2, SIG_FIGS),
        rmse: roundSig(model.metrics.rmse, SIG_FIGS),
        mae: roundSig(model.metrics.mae, SIG_FIGS),
        n: model.metrics.n,
      },
    } as T;
  }
  return {
    ...base,
    algo: "logistic_regression",
    metrics: {
      accuracy: roundSig(model.metrics.accuracy, SIG_FIGS),
      precision: roundSig(model.metrics.precision, SIG_FIGS),
      recall: roundSig(model.metrics.recall, SIG_FIGS),
      f1: roundSig(model.metrics.f1, SIG_FIGS),
      n: model.metrics.n,
    },
  } as T;
}

/**
 * Applique l'output-gate (D-18) en une seule passe : quantifie, borne largeur et taille,
 * et renvoie le modèle gated (source unique post-gate) + son buffer canonique prêt à
 * chiffrer (= exactement la sérialisation de ce modèle). Lève si un plafond est dépassé.
 */
export function gateModel<T extends TrainedModel>(model: T): { model: T; buffer: Buffer } {
  // Pré-check bon marché avant de quantifier et matérialiser le JSON (borne l'allocation, anti-DoS).
  if (model.algo === "gradient_boosted_trees") {
    if (model.trees.length > GBDT_TREES || !model.trees.every((tree) => isGbdtNode(tree, model.features.length))) {
      throw new Error("Arbres hors profil — bornés par l'output-gate");
    }
  } else if (model.coefficients.length > MAX_COEFFICIENTS) {
    throw new Error(`Trop de poids (${model.coefficients.length} > ${MAX_COEFFICIENTS}) — borné par l'output-gate`);
  }
  const gated = quantizeModel(model);
  const buffer = Buffer.from(JSON.stringify(gated));
  if (buffer.length > MAX_MODEL_BYTES) {
    throw new Error(`Sortie trop volumineuse (${buffer.length} > ${MAX_MODEL_BYTES} o) — bornée par l'output-gate`);
  }
  return { model: gated, buffer };
}
