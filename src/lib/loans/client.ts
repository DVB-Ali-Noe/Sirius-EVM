"use client";

import { useWalletStore } from "@/stores/wallet";
import { sendActiveTransaction } from "@/lib/wallet/transaction-client";
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

export async function borrowDataset(input: BorrowInput): Promise<void> {
  const prep = await fetch("/api/loans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await prep.json() as {
    loanId?: string;
    approveTransaction?: Record<string, unknown>;
    lockTransaction?: Record<string, unknown>;
    error?: string;
  };
  if (!prep.ok || !body.loanId || !body.approveTransaction || !body.lockTransaction) {
    throw new Error(body.error ?? "Préparation du lock USDC échouée");
  }
  await sendActiveTransaction(body.approveTransaction);
  const lockTxHash = await sendActiveTransaction(body.lockTransaction);
  const submit = await fetch(`/api/loans/${body.loanId}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lockTxHash }),
  });
  const submitted = await submit.json() as { error?: string };
  if (!submit.ok) throw new Error(submitted.error ?? "Lock USDC non confirmé");
}

export async function resumeLoanSubmission(): Promise<void> {
  throw new Error("Le hash de lock USDC est requis pour finaliser un emprunt interrompu.");
}

export async function cancelExpiredLoan(loanId: string): Promise<void> {
  const response = await fetch(`/api/loans/${loanId}/cancel`, { method: "POST" });
  const body = await response.json() as { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Remboursement USDC échoué");
}

interface RunLoanInput {
  loanId: string;
  datasetId: string;
  datasetReceipt: string;
}

export async function runLoanJob(input: RunLoanInput): Promise<{ modelCid: string; modelKey: string }> {
  const address = useWalletStore.getState().address;
  if (!address) throw new Error("Wallet déconnecté");
  const deliveryPublicKey = await prepareAtomicLoanDelivery(address, input.loanId);
  const authorization = await issueRunnerGrant(
    "run-loan-job",
    { loanId: input.loanId, datasetId: input.datasetId },
    [input.loanId, input.datasetId, input.datasetReceipt, deliveryPublicKey],
  );
  const response = await fetch(`/api/loans/${input.loanId}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authorization, deliveryPublicKey }),
  });
  const body = await response.json() as {
    modelCid?: string;
    runnerReceipt?: string;
    releaseEnvelope?: RunnerReleaseEnvelope;
    error?: string;
  };
  if (!response.ok || !body.modelCid || !body.runnerReceipt || !body.releaseEnvelope) {
    throw new Error(body.error ?? "Échec du job confidentiel");
  }
  const releaseEnvelopeHash = await persistAtomicLoanEnvelope(address, input.loanId, body.releaseEnvelope);
  await settleLoan(input.loanId, body.runnerReceipt, releaseEnvelopeHash);
  return retrieveLoanKey(input.loanId, body.runnerReceipt);
}

async function settleLoan(loanId: string, runnerReceipt: string, releaseEnvelopeHash: string): Promise<void> {
  const authorization = await issueRunnerGrant("settle-loan", { loanId }, [loanId, runnerReceipt, releaseEnvelopeHash]);
  const response = await fetch(`/api/loans/${loanId}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authorization, releaseEnvelopeHash }),
  });
  const body = await response.json() as { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Règlement USDC échoué");
}

export async function resumeLoanSettlement(loanId: string, runnerReceipt: string): Promise<{ modelCid: string; modelKey: string }> {
  const address = useWalletStore.getState().address;
  if (!address) throw new Error("Wallet déconnecté");
  if (!(await hasAtomicLoanEnvelope(address, loanId))) {
    throw new Error("Capsule locale absente : relance le job avant règlement.");
  }
  await settleLoan(loanId, runnerReceipt, await persistedAtomicLoanEnvelopeHash(address, loanId));
  return retrieveLoanKey(loanId, runnerReceipt);
}

export async function retrieveLoanKey(loanId: string, runnerReceipt: string): Promise<{ modelCid: string; modelKey: string }> {
  const address = useWalletStore.getState().address;
  if (!address) throw new Error("Wallet déconnecté");
  const releaseResponse = await fetch(`/api/loans/${loanId}/key`);
  const release = await releaseResponse.json() as { modelCid?: string; preimage?: string; error?: string };
  if (releaseResponse.ok && release.modelCid && release.preimage) {
    try {
      return { modelCid: release.modelCid, modelKey: await openAtomicLoanEnvelope(address, loanId, release.preimage) };
    } catch {
      // Changement d'appareil : le runner re-chiffre une livraison après vérification on-chain.
    }
  }

  const delivery = await createRunnerDelivery(`loan:${address.toLowerCase()}:${loanId}`);
  const authorization = await issueRunnerGrant("loan-model-key", { loanId }, [loanId, runnerReceipt, delivery.publicKey]);
  const response = await fetch(`/api/loans/${loanId}/key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authorization, deliveryPublicKey: delivery.publicKey }),
  });
  const body = await response.json() as { modelCid?: string; modelKeyEnvelope?: RunnerDeliveryEnvelope; error?: string };
  if (!response.ok || !body.modelCid || !body.modelKeyEnvelope) throw new Error(body.error ?? "Livraison de clé échouée");
  return { modelCid: body.modelCid, modelKey: await delivery.decrypt(body.modelKeyEnvelope) };
}
