"use client";

import { signActiveTransaction } from "@/lib/wallet/transaction-client";
import { issueRunnerGrant } from "@/lib/runner/authorization-client";

async function responseBody<T>(response: Response): Promise<T & { error?: string }> {
  return response.json() as Promise<T & { error?: string }>;
}

export async function publishDataset(datasetId: string): Promise<void> {
  const preparation = await fetch(`/api/datasets/${datasetId}/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const prepared = await responseBody<{ transaction?: Record<string, unknown> }>(preparation);
  if (!preparation.ok || !prepared.transaction) {
    throw new Error(prepared.error ?? "Préparation du MPT échouée");
  }
  const txBlob = await signActiveTransaction(prepared.transaction);
  const submission = await fetch(`/api/datasets/${datasetId}/list`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txBlob }),
  });
  const submitted = await responseBody<Record<string, never>>(submission);
  if (!submission.ok) throw new Error(submitted.error ?? "Soumission du MPT échouée");
}

export async function resumeDatasetPublication(datasetId: string): Promise<void> {
  const response = await fetch(`/api/datasets/${datasetId}/list`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await responseBody<Record<string, never>>(response);
  if (!response.ok) throw new Error(body.error ?? "Réconciliation du MPT échouée");
}

export async function destroyDataset(datasetId: string): Promise<void> {
  const preparation = await fetch(`/api/datasets/${datasetId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const prepared = await responseBody<{ transaction: Record<string, unknown> | null }>(preparation);
  if (!preparation.ok) throw new Error(prepared.error ?? "Préparation de la suppression échouée");
  const txBlob = prepared.transaction
    ? await signActiveTransaction(prepared.transaction)
    : undefined;
  const authorization = await issueRunnerGrant(
    "delete-dataset",
    { datasetId },
    [datasetId, txBlob ?? ""],
  );
  const deletion = await fetch(`/api/datasets/${datasetId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txBlob, authorization }),
  });
  const deleted = await responseBody<Record<string, never>>(deletion);
  if (!deletion.ok) throw new Error(deleted.error ?? "Suppression du dataset échouée");
}

export async function setDatasetVisibility(datasetId: string, visibility: "LISTED" | "UNLISTED" | "PRIVATE"): Promise<void> {
  const authorization = await issueRunnerGrant(
    "set-dataset-visibility",
    { datasetId },
    [datasetId, visibility],
  );
  const response = await fetch(`/api/datasets/${datasetId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visibility, authorization }),
  });
  const body = await responseBody<Record<string, never>>(response);
  if (!response.ok) throw new Error(body.error ?? "Échec du changement de visibilité");
}
