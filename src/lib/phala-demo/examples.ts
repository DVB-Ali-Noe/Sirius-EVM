import { isModelOffered, type ModelId } from "@/lib/models/registry";

export interface DemoExample { id: string; name: string; description: string; path: string; target: string; modelId: ModelId }

const EXAMPLES: ReadonlyArray<DemoExample> = [
  { id: "housing", name: "Estimate a home price", description: "Floor area, rooms and property features → estimated price.",
    path: "/examples/regression/housing-prices-train.csv", target: "price_eur", modelId: "linear_regression" },
  { id: "credit", name: "Classify default risk", description: "Synthetic credit data → class 0 or 1.",
    path: "/examples/classification/credit-default-train.csv", target: "defaulted", modelId: "logistic_regression" },
];

/** Exemples dont le profil est proposé ; `optInModels` absent lit `NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS`. */
export function demoExamples(optInModels?: string): DemoExample[] {
  return EXAMPLES.filter((sample) => isModelOffered(sample.modelId, optInModels));
}
