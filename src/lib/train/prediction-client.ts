"use client";

import { issueRunnerGrant } from "@/lib/runner/authorization-client";

/** Modèle scellé dans le runner : job self-train ou prêt réglé. Aucun modèle ne quitte l'enclave. */
export interface PredictionTarget {
  kind: "job" | "loan";
  id: string;
}

/** Sortie signée par le runner : décision 0/1 ou valeur arrondie, jamais de probabilité ni de coefficient. */
export interface PredictionResult {
  outputKind: "value" | "decision";
  output: string;
  counter: number;
}

/** Objet JSON de variables numériques finies, saisi tel quel par l'utilisateur. */
export function parsePredictionFeatures(raw: string): Record<string, number> {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error("Saisis un objet JSON de variables numériques");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !Object.values(input).every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("Saisis un objet JSON de variables numériques");
  }
  return input as Record<string, number>;
}

/**
 * Demande une prédiction signée au runner via Next. Grant `predict` lié au modèle et aux variables
 * exactes envoyées ; sur l'instance de démonstration, à la révision de session ouverte.
 */
export async function requestPrediction(
  target: PredictionTarget,
  features: Record<string, number>,
  demoSessionRevision?: number,
): Promise<PredictionResult> {
  const scope = target.kind === "job" ? { jobId: target.id } : { loanId: target.id };
  const authorization = await issueRunnerGrant(
    "predict",
    demoSessionRevision === undefined ? scope : { ...scope, demoSessionRevision },
    [target.kind, target.id, JSON.stringify(features)],
  );
  const path = target.kind === "job" ? "train" : "loans";
  const response = await fetch(`/api/${path}/${encodeURIComponent(target.id)}/predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ features, authorization }),
  });
  const body = await response.json().catch(() => null) as Partial<PredictionResult> & { error?: unknown } | null;
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "Prédiction refusée");
  if (!body || (body.outputKind !== "value" && body.outputKind !== "decision") || typeof body.output !== "string"
    || (body.outputKind === "decision" && body.output !== "0" && body.output !== "1")
    || !Number.isSafeInteger(body.counter) || body.counter! < 1) {
    throw new Error("Réponse de prédiction invalide");
  }
  return { outputKind: body.outputKind, output: body.output, counter: body.counter! };
}
