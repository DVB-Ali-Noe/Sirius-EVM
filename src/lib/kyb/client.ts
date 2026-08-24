"use client";

import { sendActiveTransaction } from "@/lib/wallet/transaction-client";

export type KybRole = "provider" | "borrower";

export async function acceptKybCredential(role: KybRole): Promise<void> {
  const endpoint = `/api/${role}/onboard`;
  const preparation = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const prepared = (await preparation.json()) as {
    transaction?: Record<string, unknown> | null;
    error?: string;
  };
  if (!preparation.ok) throw new Error(prepared.error ?? "Préparation du KYB échouée");
  if (!prepared.transaction) return;

  const txHash = await sendActiveTransaction(prepared.transaction);
  const submission = await fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txHash }),
  });
  const submitted = (await submission.json()) as { error?: string };
  if (!submission.ok) throw new Error(submitted.error ?? "Acceptation du KYB échouée");
}
