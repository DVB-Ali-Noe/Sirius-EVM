"use client";

import { useWalletStore } from "@/stores/wallet";
import { issueRunnerGrant } from "@/lib/runner/authorization-client";
import type { ModelSelection } from "@/lib/models/registry";

export interface SelfTrainResult {
  jobId: string;
  servedModelId: string;
  metrics: Record<string, number>;
}

/**
 * Lance un self-train sur son propre dataset (MLaaS, sans escrow). Nécessite une
 * session authentifiée ; le backend vérifie la propriété du dataset. Le modèle reste scellé
 * dans le runner et ne s'utilise que par prédiction signée.
 */
export async function runSelfTrain(
  datasetId: string,
  datasetReceipt: string,
  model: ModelSelection,
): Promise<SelfTrainResult> {
  const { authenticated } = useWalletStore.getState();
  if (!authenticated) throw new Error("Authentifie-toi (Se connecter) pour entraîner.");

  const jobId = crypto.randomUUID();
  const authorization = await issueRunnerGrant(
    "run-training",
    { datasetId, jobId },
    [datasetId, jobId, datasetReceipt, model.modelId, model.modelVersion, "served"],
  );
  const res = await fetch("/api/train", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ datasetId, jobId, datasetReceipt, authorization }),
  });
  const body = (await res.json()) as {
    jobId?: string;
    servedModelId?: string;
    metrics?: Record<string, number>;
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? "Entraînement échoué");
  if (body.jobId !== jobId || body.servedModelId !== jobId || !body.metrics) {
    throw new Error("Réponse runner incomplète");
  }
  return { jobId, servedModelId: body.servedModelId, metrics: body.metrics };
}
