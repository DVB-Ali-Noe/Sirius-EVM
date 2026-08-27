"use client";

import { sendActiveTransaction, signTypedDataWithActiveWallet } from "@/lib/wallet/transaction-client";

export type KybRole = "provider" | "borrower";

/**
 * Attestation parrainée, sur les instances de démonstration.
 *
 * Le sujet signe son consentement et le serveur paie le gas : un visiteur qui n'a
 * jamais touché à un réseau de test peut donc être attesté sans posséder le moindre
 * ETH. C'est le chemin que le registre prévoit explicitement.
 *
 * Retourne `false` si l'instance ne propose pas ce parrainage, pour que l'appelant
 * remonte l'erreur d'origine plutôt qu'un message trompeur.
 */
async function attestViaSponsor(): Promise<boolean> {
  const preparation = await fetch("/api/kyb/demo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!preparation.ok) return false;

  const payload = (await preparation.json()) as {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown> & { expiresAt: number };
  };

  const signature = await signTypedDataWithActiveWallet({
    domain: payload.domain,
    types: payload.types,
    primaryType: payload.primaryType,
    message: payload.message,
  });

  const soumission = await fetch("/api/kyb/demo", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresAt: payload.message.expiresAt, signature }),
  });
  const resultat = (await soumission.json()) as { error?: string };
  if (!soumission.ok) throw new Error(resultat.error ?? "Attestation parrainée échouée");
  return true;
}

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

  if (!preparation.ok) {
    // Le parcours normal suppose une attestation déjà posée hors de l'application.
    // Sur une instance de démonstration, on la pose ici plutôt que de renvoyer le
    // visiteur vers une procédure qui n'existe pas.
    if (await attestViaSponsor()) return;
    throw new Error(prepared.error ?? "Préparation du KYB échouée");
  }

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
