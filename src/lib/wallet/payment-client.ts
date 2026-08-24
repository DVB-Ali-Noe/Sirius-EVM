"use client";

import { signActiveTransaction } from "@/lib/wallet/transaction-client";

interface SendInput {
  destination: string;
  amountXrp: number;
}

/**
 * Envoi/retrait non-custodial (D-20) en 2 phases : le backend prépare le `Payment`
 * autofillé, le wallet le signe (clé jamais côté serveur), le backend le soumet.
 * Retourne le hash de transaction.
 */
export async function sendPayment(input: SendInput): Promise<string> {
  const prep = await fetch("/api/wallet/payment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const prepBody = await prep.json();
  if (!prep.ok) throw new Error(prepBody.error ?? "Préparation du paiement échouée");
  const { transaction } = prepBody as { transaction: Record<string, unknown> };

  const txBlob = await signActiveTransaction(transaction);

  const sub = await fetch("/api/wallet/payment", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txBlob }),
  });
  const subBody = await sub.json();
  if (!sub.ok) throw new Error(subBody.error ?? "Soumission du paiement échouée");
  return subBody.txHash as string;
}
