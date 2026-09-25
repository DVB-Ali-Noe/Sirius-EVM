import type { ModelId } from "@/lib/models/registry";

export const DEMO_EXAMPLES: ReadonlyArray<{ id: string; name: string; description: string; path: string; target: string; modelId: ModelId }> = [
  { id: "housing", name: "Estimer un prix immobilier", description: "Surface, pièces et caractéristiques du logement → prix estimé.",
    path: "/examples/regression/housing-prices-train.csv", target: "price_eur", modelId: "linear_regression" },
  { id: "credit", name: "Classer un risque de défaut", description: "Données synthétiques de crédit → classe 0 ou 1.",
    path: "/examples/classification/credit-default-train.csv", target: "defaulted", modelId: "logistic_regression" },
];
