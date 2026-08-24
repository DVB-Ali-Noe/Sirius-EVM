"use client";

import { useWalletStore } from "@/stores/wallet";
import { signActiveTransaction } from "@/lib/wallet/transaction-client";
import { issueRunnerGrant } from "@/lib/runner/authorization-client";
import { createRunnerDelivery } from "@/lib/runner/delivery-client";
import {
  hasAtomicLoanEnvelope,
  openAtomicLoanEnvelope,
  persistAtomicLoanEnvelope,
  persistedAtomicLoanEnvelopeHash,
  prepareAtomicLoanDelivery,
} from "@/lib/runner/atomic-delivery-client";
import type { RunnerDeliveryEnvelope, RunnerReleaseEnvelope } from "@/lib/tee/contract";

interface BorrowInput {
  datasetId: string;
}

/**
 * Emprunt non-custodial en 2 phases : le backend prépare l'`EscrowCreate`, le wallet
 * du borrower le signe (clé jamais côté serveur), le backend vérifie le blob et le soumet.
 */
export async function borrowDataset(input: BorrowInput): Promise<void> {
  const prep = await fetch("/api/loans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const prepBody = await prep.json();
  if (!prep.ok) throw new Error(prepBody.error ?? "Préparation de l'emprunt échouée");
  const { loanId, transaction } = prepBody as { loanId: string; transaction: Record<string, unknown> };

  const txBlob = await signActiveTransaction(transaction);

  const sub = await fetch(`/api/loans/${loanId}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txBlob }),
  });
  const subBody = await sub.json();
  if (!sub.ok) throw new Error(subBody.error ?? "Soumission de l'escrow échouée");
}

export async function resumeLoanSubmission(loanId: string): Promise<void> {
  const res = await fetch(`/api/loans/${loanId}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const body = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? "Réconciliation de l'escrow échouée");
}

export async function cancelExpiredLoan(loanId: string): Promise<void> {
  const response = await fetch(`/api/loans/${loanId}/cancel`, { method: "POST" });
  const body = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Remboursement de l’escrow échoué");
}

interface RunLoanInput {
  loanId: string;
  datasetId: string;
  datasetReceipt: string;
  escrowTxHash: string;
  escrowSequence: number;
}

export async function runLoanJob(input: RunLoanInput): Promise<{ modelCid: string; modelKey: string }> {
  const address = useWalletStore.getState().address;
  if (!address) throw new Error("Wallet déconnecté");
  const deliveryPublicKey = await prepareAtomicLoanDelivery(address, input.loanId);
  const authorization = await issueRunnerGrant(
    "run-loan-job",
    { loanId: input.loanId, datasetId: input.datasetId },
    [
      input.loanId,
      input.datasetId,
      input.datasetReceipt,
      input.escrowTxHash,
      String(input.escrowSequence),
      deliveryPublicKey,
    ],
  );
  const res = await fetch(`/api/loans/${input.loanId}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authorization, deliveryPublicKey }),
  });
  const body = (await res.json()) as {
    modelCid?: string;
    runnerReceipt?: string;
    releaseEnvelope?: RunnerReleaseEnvelope;
    error?: string;
  };
  if (!res.ok || !body.modelCid || !body.runnerReceipt || !body.releaseEnvelope) {
    throw new Error(body.error ?? "Échec du job TEE");
  }
  const releaseEnvelopeHash = await persistAtomicLoanEnvelope(address, input.loanId, body.releaseEnvelope);
  const settleTxHash = await settleLoan(input.loanId, body.runnerReceipt, releaseEnvelopeHash);
  const delivery = await retrieveLoanKey(input.loanId, body.runnerReceipt, settleTxHash);
  return { modelCid: body.modelCid, modelKey: delivery.modelKey };
}

async function settleLoan(loanId: string, runnerReceipt: string, releaseEnvelopeHash: string): Promise<string> {
  const authorization = await issueRunnerGrant(
    "settle-loan",
    { loanId },
    [loanId, runnerReceipt, releaseEnvelopeHash],
  );
  const res = await fetch(`/api/loans/${loanId}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authorization, releaseEnvelopeHash }),
  });
  const body = (await res.json()) as { settleTxHash?: string; error?: string };
  if (!res.ok || !body.settleTxHash) throw new Error(body.error ?? "Règlement XRPL échoué");
  return body.settleTxHash;
}

export async function resumeLoanSettlement(
  loanId: string,
  runnerReceipt: string,
): Promise<{ modelCid: string; modelKey: string }> {
  const address = useWalletStore.getState().address;
  if (!address) throw new Error("Wallet déconnecté");

  let activeReceipt = runnerReceipt;
  let releaseEnvelopeHash: string;
  if (!(await hasAtomicLoanEnvelope(address, loanId))) {
    const deliveryPublicKey = await prepareAtomicLoanDelivery(address, loanId);
    const authorization = await issueRunnerGrant(
      "prepare-loan-delivery",
      { loanId },
      [loanId, runnerReceipt, deliveryPublicKey],
    );
    const res = await fetch(`/api/loans/${loanId}/delivery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorization, deliveryPublicKey }),
    });
    const body = (await res.json()) as {
      runnerReceipt?: string;
      releaseEnvelope?: RunnerReleaseEnvelope;
      error?: string;
    };
    if (!res.ok || !body.runnerReceipt || !body.releaseEnvelope) {
      throw new Error(body.error ?? "Préparation de livraison échouée");
    }
    releaseEnvelopeHash = await persistAtomicLoanEnvelope(address, loanId, body.releaseEnvelope);
    activeReceipt = body.runnerReceipt;
  } else {
    releaseEnvelopeHash = await persistedAtomicLoanEnvelopeHash(address, loanId);
  }

  const settleTxHash = await settleLoan(loanId, activeReceipt, releaseEnvelopeHash);
  return retrieveLoanKey(loanId, activeReceipt, settleTxHash);
}

export async function retrieveLoanKey(
  loanId: string,
  runnerReceipt: string,
  settleTxHash: string,
): Promise<{ modelCid: string; modelKey: string }> {
  const address = useWalletStore.getState().address;
  if (!address) throw new Error("Wallet déconnecté");

  const releaseRes = await fetch(`/api/loans/${loanId}/key`);
  const releaseBody = (await releaseRes.json()) as {
    modelCid?: string;
    fulfillmentHex?: string;
    error?: string;
  };
  if (releaseRes.ok && releaseBody.modelCid && releaseBody.fulfillmentHex) {
    try {
      return {
        modelCid: releaseBody.modelCid,
        modelKey: await openAtomicLoanEnvelope(address, loanId, releaseBody.fulfillmentHex),
      };
    } catch {
      // Récupération multi-device : le runner re-chiffre post-règlement pour cette session.
    }
  }

  const delivery = await createRunnerDelivery(`loan:${address}:${loanId}`);
  const authorization = await issueRunnerGrant(
    "loan-model-key",
    { loanId },
    [loanId, runnerReceipt, settleTxHash, delivery.publicKey],
  );
  const res = await fetch(`/api/loans/${loanId}/key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authorization, deliveryPublicKey: delivery.publicKey }),
  });
  const body = (await res.json()) as {
    modelCid?: string;
    modelKeyEnvelope?: RunnerDeliveryEnvelope;
    error?: string;
  };
  if (!res.ok || !body.modelCid || !body.modelKeyEnvelope) {
    throw new Error(body.error ?? "Livraison de clé échouée");
  }
  return { modelCid: body.modelCid, modelKey: await delivery.decrypt(body.modelKeyEnvelope) };
}
