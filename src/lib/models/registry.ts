import { GBDT_TREES, isGbdtNode, type GbdtNode } from "./gbdt";

/**
 * `optIn` : profil proposé seulement s'il figure dans `NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS`
 * (identifiants séparés par des virgules). Il faut que le registre on-chain accepte le profil,
 * que l'image du runner sache l'entraîner et que le tarif le couvre ; sinon le mint échoue.
 *
 * `linear_regression` est facultatif depuis D-31 : un modèle linéaire se reconstruit avec environ
 * d + 1 prédictions signées (D-27). Son code reste en place pour les datasets et prêts existants ;
 * le réactiver se fait sans changement de code, en l'ajoutant à la variable sur Vercel et au
 * Compose du runner (`render-phala-v7.mjs --opt-in-models=…`).
 */
export const MODEL_REGISTRY = {
  linear_regression: {
    id: "linear_regression",
    version: "1.0.0",
    label: "Linear regression",
    description: "Predicts a continuous numeric value.",
    metrics: ["R²", "RMSE", "MAE"],
    optIn: true,
  },
  logistic_regression: {
    id: "logistic_regression",
    version: "1.0.0",
    label: "Binary logistic regression",
    description: "Classifies a target strictly encoded as 0 or 1.",
    metrics: ["Accuracy", "Precision", "Recall", "F1", "Probability"],
    optIn: false,
  },
  /**
   * 1.1.0 (24 octobre 2026, E2 minimale) : plafond d'influence k = 1, seuils jamais sur une
   * valeur du fichier, métriques arrondies, `trainAuc` remplacé par `aucGap`, `n` à 2 chiffres,
   * en-têtes publiés restreints. La sortie change : nouvelle empreinte de profil on-chain.
   */
  gradient_boosted_trees: {
    id: "gradient_boosted_trees",
    version: "1.1.0",
    label: "Binary gradient-boosted trees",
    description: "Classifies a 0/1 target with shallow boosted trees, scored on a held-out fifth of the rows.",
    metrics: ["Held-out AUC", "Held-out accuracy", "Held-out precision", "Held-out recall", "Held-out F1", "Train/held-out AUC gap", "Probability"],
    optIn: true,
  },
} as const;

export type ModelId = keyof typeof MODEL_REGISTRY;

export type ModelSelection = {
  [Id in ModelId]: {
    modelId: Id;
    modelVersion: (typeof MODEL_REGISTRY)[Id]["version"];
  };
}[ModelId];

export interface LinearRegressionModel {
  algo: "linear_regression";
  version: typeof MODEL_REGISTRY.linear_regression.version;
  target: string;
  features: string[];
  coefficients: number[];
  metrics: { r2: number; rmse: number; mae: number; n: number };
}

export interface LogisticRegressionModel {
  algo: "logistic_regression";
  version: typeof MODEL_REGISTRY.logistic_regression.version;
  target: string;
  features: string[];
  coefficients: number[];
  metrics: { accuracy: number; precision: number; recall: number; f1: number; n: number };
}

export interface GradientBoostedTreesModel {
  algo: "gradient_boosted_trees";
  version: typeof MODEL_REGISTRY.gradient_boosted_trees.version;
  target: string;
  features: string[];
  /** Log-odds initial ; la probabilité de la classe 1 est sigmoid(baseScore + somme des feuilles atteintes). */
  baseScore: number;
  trees: GbdtNode[];
  metrics: {
    heldOutAuc: number;
    heldOutAccuracy: number;
    heldOutPrecision: number;
    heldOutRecall: number;
    heldOutF1: number;
    /** `trainAuc − heldOutAuc` : le sur-apprentissage, seule information utile du `trainAuc` brut. */
    aucGap: number;
    /** Lignes du fichier, en-tête exclu, publiées arrondies (jamais le compte exact). */
    n: number;
  };
}

export type DeliveredModel = LinearRegressionModel | LogisticRegressionModel | GradientBoostedTreesModel;

export const DEFAULT_MODEL_SELECTION: ModelSelection = {
  modelId: "logistic_regression",
  modelVersion: MODEL_REGISTRY.logistic_regression.version,
};

/**
 * Profil proposé à la publication et accepté par le runner pour un nouvel usage. Les
 * enregistrements existants se lisent toujours avec `modelSelection`, quel que soit cet état.
 */
export function isModelOffered(modelId: ModelId, optInModels = process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS): boolean {
  if (!MODEL_REGISTRY[modelId].optIn) return true;
  return (optInModels ?? "").split(",").some((id) => id.trim() === modelId);
}

export const MODEL_OPTIONS = Object.values(MODEL_REGISTRY).filter((model) => isModelOffered(model.id));

export function selectionForModelId(modelId: ModelId): ModelSelection {
  return { modelId, modelVersion: MODEL_REGISTRY[modelId].version } as ModelSelection;
}

export function modelSelectionForId(modelId: unknown): ModelSelection | null {
  if (typeof modelId !== "string" || !Object.hasOwn(MODEL_REGISTRY, modelId)) return null;
  return selectionForModelId(modelId as ModelId);
}

export function modelSelection(modelId: unknown, modelVersion: unknown): ModelSelection | null {
  if (typeof modelVersion !== "string") return null;
  const selection = modelSelectionForId(modelId);
  if (!selection) return null;
  return selection.modelVersion === modelVersion ? selection : null;
}

export function trainingProfileHash(selection: ModelSelection): Hex {
  return keccak256(stringToBytes(`sirius.training-profile.v1:${selection.modelId}:${selection.modelVersion}`));
}

export function modelDisplayName(selection: ModelSelection): string {
  return `${MODEL_REGISTRY[selection.modelId].label} v${selection.modelVersion}`;
}

/** Empreinte `servedModelFingerprint` (`sm1` + SHA-256 hex) : les anciens CID IPFS n'ont aucun modèle scellé. */
const SERVED_MODEL_FINGERPRINT = /^sm1[0-9a-f]{64}$/;

/** Vrai si `modelCid` désigne un modèle scellé dans le runner ; un modèle historique livré est indisponible. */
export function isServedModelFingerprint(modelCid: string | null | undefined): boolean {
  return typeof modelCid === "string" && SERVED_MODEL_FINGERPRINT.test(modelCid);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function hasTargetAndFeatures(value: Record<string, unknown>): value is Record<string, unknown> & { features: string[] } {
  return (
    typeof value.target === "string" &&
    value.target.length > 0 &&
    Array.isArray(value.features) &&
    value.features.length > 0 &&
    value.features.length <= 31 &&
    value.features.every((feature) => typeof feature === "string" && feature.length > 0) &&
    new Set(value.features).size === value.features.length
  );
}

function isModelBase(value: Record<string, unknown>): boolean {
  return (
    hasTargetAndFeatures(value) &&
    Array.isArray(value.coefficients) &&
    value.coefficients.length === value.features.length + 1 &&
    value.coefficients.every(isFiniteNumber)
  );
}

function isProbabilityMetric(value: unknown): boolean {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function exactMetrics(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && keys.every((key) => key in value) &&
    Object.keys(value).length === keys.length;
}

export function parseDeliveredModel(value: unknown): DeliveredModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Modèle déchiffré invalide");
  const model = value as Record<string, unknown>;
  if (model.algo === "gradient_boosted_trees") {
    const metrics = model.metrics;
    if (
      exactMetrics(model, ["algo", "version", "target", "features", "baseScore", "trees", "metrics"]) &&
      model.version === MODEL_REGISTRY.gradient_boosted_trees.version &&
      hasTargetAndFeatures(model) &&
      isFiniteNumber(model.baseScore) &&
      Array.isArray(model.trees) && model.trees.length > 0 && model.trees.length <= GBDT_TREES &&
      model.trees.every((tree) => isGbdtNode(tree, model.features.length)) &&
      exactMetrics(metrics, ["heldOutAuc", "heldOutAccuracy", "heldOutPrecision", "heldOutRecall", "heldOutF1", "aucGap", "n"]) &&
      [metrics.heldOutAuc, metrics.heldOutAccuracy, metrics.heldOutPrecision, metrics.heldOutRecall, metrics.heldOutF1].every(isProbabilityMetric) &&
      isFiniteNumber(metrics.aucGap) && Math.abs(metrics.aucGap) <= 1 &&
      isCount(metrics.n)
    ) {
      return model as unknown as GradientBoostedTreesModel;
    }
    throw new Error("Modèle déchiffré invalide");
  }
  if (
    Object.keys(model).length !== 6 ||
    !["algo", "version", "target", "features", "coefficients", "metrics"].every((key) => key in model) ||
    !isModelBase(model) ||
    typeof model.algo !== "string" ||
    typeof model.version !== "string"
  ) {
    throw new Error("Modèle déchiffré invalide");
  }

  if (
    model.algo === "linear_regression" &&
    model.version === MODEL_REGISTRY.linear_regression.version &&
    exactMetrics(model.metrics, ["r2", "rmse", "mae", "n"]) &&
    isFiniteNumber(model.metrics.r2) &&
    isFiniteNumber(model.metrics.rmse) && model.metrics.rmse >= 0 &&
    isFiniteNumber(model.metrics.mae) && model.metrics.mae >= 0 &&
    isCount(model.metrics.n)
  ) {
    return model as unknown as LinearRegressionModel;
  }

  if (
    model.algo === "logistic_regression" &&
    model.version === MODEL_REGISTRY.logistic_regression.version &&
    exactMetrics(model.metrics, ["accuracy", "precision", "recall", "f1", "n"]) &&
    [model.metrics.accuracy, model.metrics.precision, model.metrics.recall, model.metrics.f1].every(isProbabilityMetric) &&
    isCount(model.metrics.n)
  ) {
    return model as unknown as LogisticRegressionModel;
  }

  throw new Error("Modèle déchiffré invalide");
}
import { keccak256, stringToBytes, type Hex } from "viem";
