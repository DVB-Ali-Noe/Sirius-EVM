"use client";

import { useWalletStore } from "@/stores/wallet";
import { SETTLEMENT_FINALITY_PENDING, SETTLEMENT_FINALITY_PENDING_FAST, SETTLEMENT_QUEUED } from "./settlement-status";
import { sendActiveTransaction } from "@/lib/wallet/transaction-client";
import { guardRefundTransaction } from "@/lib/wallet/transaction-guard";
import { issueRunnerGrant } from "@/lib/runner/authorization-client";
import { createRunnerDelivery } from "@/lib/runner/delivery-client";
import {
  openAtomicLoanEnvelope,
  persistAtomicLoanEnvelope,
  prepareAtomicLoanDelivery,
} from "@/lib/runner/atomic-delivery-client";
import type { RunnerDeliveryEnvelope, RunnerReleaseEnvelope } from "@/lib/tee/contract";
import type { ModelSelection } from "@/lib/models/registry";
import { computeQuoteHash, type ComputeQuote, type SignedComputeQuote } from "@/lib/billing/quote";
import { escrowBillingVersion, quotedTransactions, verifyBorrowQuote } from "@/lib/billing/client";
import { legacyBorrowTransactions } from "./legacy-client";
interface BorrowInput {
  datasetId: string;
  priceUsdcAtomic: string;
  confirmQuote?: (quote: ComputeQuote) => Promise<boolean>;
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
  if (!submit.ok) throw new Error(submitted.error ?? "Lock de paiement non confirmé");
  window.sessionStorage.removeItem(lockSubmissionStorageKey(loanId));
}

export async function borrowDataset(input: BorrowInput): Promise<boolean> {
  const snapshot = useWalletStore.getState();
  const assertCurrent = () => {
    const current = useWalletStore.getState();
    if (current.revision !== snapshot.revision || current.address !== snapshot.address || !current.authenticated) {
      throw new Error("Le wallet a changé. Relance l’opération.");
    }
  };
  const prep = await fetch("/api/loans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ datasetId: input.datasetId }),
  });
  const body = await prep.json() as {
    loanId?: string;
    approveTransaction?: Record<string, unknown>;
    lockTransaction?: Record<string, unknown>;
    billingQuote?: SignedComputeQuote;
    error?: string;
  };
  if (!prep.ok || !body.loanId || !body.approveTransaction || !body.lockTransaction) {
    throw new Error(body.error ?? "Préparation du lock de paiement échouée");
  }
  assertCurrent();
  const billingVersion = await escrowBillingVersion();
  if (Boolean(body.billingQuote) !== (billingVersion === 7)) throw new Error("Devis compute absent ou incompatible avec l’escrow");
  const signedQuote = body.billingQuote
    ? await verifyBorrowQuote(body.billingQuote, { loanId: body.loanId, datasetId: input.datasetId, borrower: snapshot.address! }) : undefined;
  if (signedQuote && signedQuote.quote.datasetAmount !== input.priceUsdcAtomic) throw new Error("Prix du dataset modifié. Recharge le catalogue.");
  const legacy = signedQuote ? undefined : await legacyBorrowTransactions({
    loanId: body.loanId, datasetId: input.datasetId, priceUsdcAtomic: input.priceUsdcAtomic,
    initialLock: body.lockTransaction,
  });
  if (signedQuote) {
    if (!input.confirmQuote) throw new Error("Acceptation du devis compute requise");
    if (!await input.confirmQuote(signedQuote.quote)) return false;
    if (signedQuote.quote.expiresAt * 1000 <= Date.now()) throw new Error("Devis compute expiré");
  }
  assertCurrent();
  await sendActiveTransaction(signedQuote ? quotedTransactions(signedQuote).approve : { ...legacy!.approve }, { waitForConfirmation: true, assertCurrent });
  const renewal = await fetch(`/api/loans/${body.loanId}/authorize`, { method: "POST" });
  const authorized = await renewal.json() as { lockTransaction?: Record<string, unknown>; authorizationDeadline?: number; billingQuote?: SignedComputeQuote; error?: string };
  if (!renewal.ok || !authorized.lockTransaction) throw new Error(authorized.error ?? "Autorisation du lock refusée");
  if (!authorized.authorizationDeadline || authorized.authorizationDeadline * 1_000 <= Date.now()) {
    throw new Error("Préparation du prêt expirée. Relance l’emprunt ; l’approbation du stablecoin reste acquise.");
  }
  if (Boolean(signedQuote) !== Boolean(authorized.billingQuote)) throw new Error("Devis compute hors scope");
  if (signedQuote && computeQuoteHash(signedQuote.quote) !== computeQuoteHash(authorized.billingQuote!.quote)) throw new Error("Devis compute hors scope");
  const lockTxHash = await sendActiveTransaction(signedQuote ? { ...quotedTransactions(signedQuote).lock } : { ...legacy!.lock(authorized.lockTransaction, authorized.authorizationDeadline) }, { assertCurrent });
  window.sessionStorage.setItem(lockSubmissionStorageKey(body.loanId), lockTxHash);
  // Le serveur persiste SUBMITTING avant d'attendre le reçu, même si l'onglet ferme.
  await submitLoanLock(body.loanId, lockTxHash);
  return true;
}

export async function resumeLoanSubmission(loanId: string, lockTxHash?: string): Promise<void> {
  await submitLoanLock(loanId, lockTxHash);
}

export async function cancelExpiredLoan(loanId: string): Promise<void> {
  const response = await fetch(`/api/loans/${loanId}/cancel`, { method: "POST" });
  const body = await response.json() as { error?: string; transaction?: Record<string, unknown> };
  if (!response.ok) throw new Error(body.error ?? "Remboursement de l’escrow échoué");
  if (body.transaction) {
    await sendActiveTransaction(guardRefundTransaction(body.transaction), { waitForConfirmation: true });
    const confirmed = await fetch(`/api/loans/${loanId}/cancel`, { method: "POST" });
    const result = await confirmed.json() as { error?: string; transaction?: unknown };
    if (!confirmed.ok || result.transaction) throw new Error(result.error ?? "Remboursement à réconcilier");
  }
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
  if (!response.ok || !body.modelCid || !body.runnerReceipt) {
    throw new Error(body.error ?? "Échec du job confidentiel");
  }
  if (body.releaseEnvelope) await persistAtomicLoanEnvelope(address, input.loanId, body.releaseEnvelope);
  await settleLoan(input.loanId, body.runnerReceipt);
  return retrieveLoanKey(input.loanId, body.runnerReceipt);
}

/**
 * Attentes avant de redemander un règlement refusé parce qu'un autre occupe le wallet du runner
 * (`SETTLEMENT_QUEUED`, audit PAR-02). Chaque essai porte une nouvelle autorisation : le runner
 * refuse le rejeu d'un grant. Au-delà, le message s'affiche et le reaper reprend le prêt.
 */
export const SETTLEMENT_QUEUED_RETRY_MS = [2_000, 4_000, 8_000] as const;

/**
 * Relectures d'un règlement déjà envoyé, au palier rapide seulement (`SETTLEMENT_FINALITY_PENDING_FAST`) :
 * le réseau le confirme en général sous une minute. La page reste en « Règlement… » et livre le
 * modèle dès la confirmation, au lieu d'afficher l'attente comme un échec et de laisser l'emprunteur
 * recharger. Environ 2 min 30 au total, sous le quota de la route (10 par minute). Au-delà, ou au
 * palier long (un quart d'heure), le message d'attente remonte comme avant.
 */
export const SETTLEMENT_PENDING_RETRY_MS = [5_000, 10_000, 10_000, 15_000, 15_000, 20_000, 30_000, 45_000] as const;

export async function settleLoan(
  loanId: string,
  runnerReceipt: string,
  {
    wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    grant = issueRunnerGrant,
  }: { wait?: (ms: number) => Promise<void>; grant?: typeof issueRunnerGrant } = {},
): Promise<void> {
  let queued = 0;
  let pending = 0;
  for (;;) {
    const authorization = await grant("settle-loan", { loanId }, [loanId, runnerReceipt]);
    const response = await fetch(`/api/loans/${loanId}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorization }),
    });
    const body = await response.json() as { error?: string; pending?: boolean };
    // Le serveur annonce l'attente selon le palier du prêt (secondes ou quart d'heure) ; sans message, l'attente longue.
    if (response.status === 202 && body.pending) {
      const message = typeof body.error === "string" && body.error ? body.error : SETTLEMENT_FINALITY_PENDING;
      if (message === SETTLEMENT_FINALITY_PENDING_FAST && pending < SETTLEMENT_PENDING_RETRY_MS.length) {
        await wait(SETTLEMENT_PENDING_RETRY_MS[pending++]);
        continue;
      }
      throw new Error(message);
    }
    if (response.status === 503 && body.error === SETTLEMENT_QUEUED && queued < SETTLEMENT_QUEUED_RETRY_MS.length) {
      await wait(SETTLEMENT_QUEUED_RETRY_MS[queued++]);
      continue;
    }
    if (!response.ok) throw new Error(body.error ?? "Règlement de l’escrow échoué");
    return;
  }
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
