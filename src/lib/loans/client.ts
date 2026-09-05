"use client";

import { useWalletStore } from "@/stores/wallet";
import { sendActiveTransaction } from "@/lib/wallet/transaction-client";
import { waitForTransactionExternal } from "@/lib/wallet/manager";
import { issueRunnerGrant } from "@/lib/runner/authorization-client";
import { createRunnerDelivery } from "@/lib/runner/delivery-client";
import {
  openAtomicLoanEnvelope,
  persistAtomicLoanEnvelope,
  prepareAtomicLoanDelivery,
} from "@/lib/runner/atomic-delivery-client";
import type { RunnerDeliveryEnvelope, RunnerReleaseEnvelope } from "@/lib/tee/contract";
import type { ModelSelection } from "@/lib/models/registry";
interface BorrowInput {
  datasetId: string;
}

function lockSubmissionStorageKey(loanId: string): string {
  return `sirius:loan-lock:${loanId}`;
}

function storedLockTxHash(loanId: string): string | null {
  return window.sessionStorage.getItem(lockSubmissionStorageKey(loanId));
}

async function submitLoanLock(loanId: string, lockTxHash?: string): Promise<void> {
  const hash = lockTxHash ?? storedLockTxHash(loanId);
  const submit = await fetch(`/api/loans/${loanId}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(hash ? { lockTxHash: hash } : {}),
  });
  const submitted = await submit.json() as { error?: string };
  if (!submit.ok) throw new Error(submitted.error ?? "Lock USDC non confirmé");
  window.sessionStorage.removeItem(lockSubmissionStorageKey(loanId));
}

export async function borrowDataset(input: BorrowInput): Promise<void> {
  const prep = await fetch("/api/loans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ datasetId: input.datasetId }),
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
  await sendActiveTransaction(body.approveTransaction, { waitForConfirmation: true });
  const lockTxHash = await sendActiveTransaction(body.lockTransaction);
  window.sessionStorage.setItem(lockSubmissionStorageKey(body.loanId), lockTxHash);
  await waitForTransactionExternal(lockTxHash);
  await submitLoanLock(body.loanId, lockTxHash);
}

export async function resumeLoanSubmission(loanId: string, lockTxHash?: string): Promise<void> {
  await submitLoanLock(loanId, lockTxHash);
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
  model: ModelSelection;
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
      deliveryPublicKey,
      input.model.modelId,
      input.model.modelVersion,
    ],
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
  await persistAtomicLoanEnvelope(address, input.loanId, body.releaseEnvelope);
  await settleLoan(input.loanId, body.runnerReceipt);
  return retrieveLoanKey(input.loanId, body.runnerReceipt);
}

async function settleLoan(loanId: string, runnerReceipt: string): Promise<void> {
  const authorization = await issueRunnerGrant("settle-loan", { loanId }, [loanId, runnerReceipt]);
  const response = await fetch(`/api/loans/${loanId}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authorization }),
  });
  const body = await response.json() as { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Règlement USDC échoué");
}

export async function resumeLoanSettlement(loanId: string, runnerReceipt: string): Promise<{ modelCid: string; modelKey: string }> {
  const address = useWalletStore.getState().address;
  if (!address) throw new Error("Wallet déconnecté");
  await settleLoan(loanId, runnerReceipt);
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
