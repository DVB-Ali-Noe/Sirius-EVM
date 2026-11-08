"use client";

import { useWalletStore } from "@/stores/wallet";
import { CALLS_PENDING, EXTENSION_PENDING, SETTLEMENT_FINALITY_PENDING, SETTLEMENT_FINALITY_PENDING_FAST, SETTLEMENT_QUEUED } from "./settlement-status";
import { ENCLAVE_STARTING_CODE, responseError } from "@/lib/train/enclave-wait";
import type { CallPackSize } from "@/lib/billing/api-pricing";
import { sendActiveTransaction } from "@/lib/wallet/transaction-client";
import { guardRefundTransaction } from "@/lib/wallet/transaction-guard";
import { issueRunnerGrant } from "@/lib/runner/authorization-client";
import type { ModelSelection } from "@/lib/models/registry";
import { computeQuoteHash, type ComputeQuote, type SignedComputeQuote } from "@/lib/billing/quote";
import { escrowBillingVersion, quotedTransactions, verifyBorrowQuote } from "@/lib/billing/client";
import { datasetAmountFor } from "@/lib/billing/rental";
import { legacyBorrowTransactions, type LegacyBorrowTransactions } from "./legacy-client";
interface BorrowInput {
  datasetId: string;
  /** Prix par jour affiché (D-29). */
  priceUsdcAtomic: string;
  /** Durée choisie, 1 à `maxRentalDays` du dataset ; signée dans le devis. */
  rentalDays: number;
  confirmQuote?: (quote: ComputeQuote) => Promise<boolean>;
}

interface ExtendInput {
  /** Prêt d'origine à prolonger. */
  loanId: string;
  /** Dataset du prêt d'origine : le devis de prolongation doit le viser. */
  datasetId: string;
  rentalDays: number;
  confirmQuote: (quote: ComputeQuote) => Promise<boolean>;
}

interface BuyCallsInput {
  /** Prêt loué d'origine, crédité du pack. */
  loanId: string;
  /** Dataset du prêt d'origine : le devis du pack doit le viser. */
  datasetId: string;
  size: CallPackSize;
  confirmQuote: (quote: ComputeQuote) => Promise<boolean>;
}

interface PreparedLock {
  loanId?: string;
  approveTransaction?: Record<string, unknown>;
  lockTransaction?: Record<string, unknown>;
  billingQuote?: SignedComputeQuote;
  error?: string;
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

function walletGuard() {
  const snapshot = useWalletStore.getState();
  const assertCurrent = () => {
    const current = useWalletStore.getState();
    if (current.revision !== snapshot.revision || current.address !== snapshot.address || !current.authenticated) {
      throw new Error("Le wallet a changé. Relance l’opération.");
    }
  };
  return { address: snapshot.address, assertCurrent };
}

/**
 * Approbation, renouvellement de l'autorisation, lock puis `submit` d'un prêt préparé (emprunt ou
 * prolongation), sur le devis déjà accepté par l'emprunteur.
 */
async function approveAndLock(
  loanId: string,
  signedQuote: SignedComputeQuote | undefined,
  legacy: LegacyBorrowTransactions | undefined,
  assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  await sendActiveTransaction(signedQuote ? quotedTransactions(signedQuote).approve : { ...legacy!.approve }, { waitForConfirmation: true, assertCurrent });
  const renewal = await fetch(`/api/loans/${loanId}/authorize`, { method: "POST" });
  const authorized = await renewal.json() as { lockTransaction?: Record<string, unknown>; authorizationDeadline?: number; billingQuote?: SignedComputeQuote; error?: string };
  if (!renewal.ok || !authorized.lockTransaction) throw new Error(authorized.error ?? "Autorisation du lock refusée");
  if (!authorized.authorizationDeadline || authorized.authorizationDeadline * 1_000 <= Date.now()) {
    throw new Error("Préparation du prêt expirée. Relance l’emprunt ; l’approbation du stablecoin reste acquise.");
  }
  if (Boolean(signedQuote) !== Boolean(authorized.billingQuote)) throw new Error("Devis compute hors scope");
  if (signedQuote && computeQuoteHash(signedQuote.quote) !== computeQuoteHash(authorized.billingQuote!.quote)) throw new Error("Devis compute hors scope");
  const lockTxHash = await sendActiveTransaction(signedQuote ? { ...quotedTransactions(signedQuote).lock } : { ...legacy!.lock(authorized.lockTransaction, authorized.authorizationDeadline) }, { assertCurrent });
  window.sessionStorage.setItem(lockSubmissionStorageKey(loanId), lockTxHash);
  // Le serveur persiste SUBMITTING avant d'attendre le reçu, même si l'onglet ferme.
  await submitLoanLock(loanId, lockTxHash);
}

/**
 * Emprunt complet sur le devis accepté. Enclave à l'arrêt : la préparation répond 503
 * `enclave_starting` avant toute écriture et remonte en `EnclaveStartingError`, à relancer par
 * l'appelant (`retryWhileEnclaveStarts`) ; rien n'est signé ni payé avant elle.
 */
export async function borrowDataset(input: BorrowInput): Promise<boolean> {
  const { address, assertCurrent } = walletGuard();
  const prep = await fetch("/api/loans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ datasetId: input.datasetId, rentalDays: input.rentalDays }),
  });
  if (!prep.ok) throw await responseError(prep, "Préparation du lock de paiement échouée");
  const body = await prep.json() as PreparedLock;
  if (!body.loanId || !body.approveTransaction || !body.lockTransaction) {
    throw new Error(body.error ?? "Préparation du lock de paiement échouée");
  }
  assertCurrent();
  const billingVersion = await escrowBillingVersion();
  if (Boolean(body.billingQuote) !== (billingVersion === 7)) throw new Error("Devis compute absent ou incompatible avec l’escrow");
  const signedQuote = body.billingQuote
    ? await verifyBorrowQuote(body.billingQuote, { loanId: body.loanId, datasetId: input.datasetId, borrower: address! }) : undefined;
  // Prix par jour × jours choisis (D-29) : un devis sur une autre durée ou un autre prix est refusé.
  if (signedQuote && (signedQuote.quote.rentalDays !== input.rentalDays || signedQuote.quote.extendsLoanId !== undefined
    || signedQuote.quote.datasetAmount !== datasetAmountFor(input.priceUsdcAtomic, input.rentalDays))) {
    throw new Error("Prix du dataset modifié. Recharge le catalogue.");
  }
  const legacy = signedQuote ? undefined : await legacyBorrowTransactions({
    loanId: body.loanId, datasetId: input.datasetId, priceUsdcAtomic: input.priceUsdcAtomic,
    initialLock: body.lockTransaction,
  });
  if (signedQuote) {
    if (!input.confirmQuote) throw new Error("Acceptation du devis compute requise");
    if (!await input.confirmQuote(signedQuote.quote)) return false;
    if (signedQuote.quote.expiresAt * 1000 <= Date.now()) throw new Error("Devis compute expiré");
  }
  await approveAndLock(body.loanId, signedQuote, legacy, assertCurrent);
  return true;
}

/**
 * Prolonge la location du prêt `loanId` de `rentalDays` jours (D-29) : prêt de prolongation préparé
 * par le serveur, devis accepté, même lock qu'un emprunt, puis `release` demandé au runner. Renvoie
 * `false` si le devis est refusé. Lock pas encore finalisé ou `release` en attente de finalité :
 * la prolongation est payée et le serveur (reaper) l'applique seul, sans autre action. Enclave à
 * l'arrêt à la préparation : `EnclaveStartingError`, avant tout paiement, comme `borrowDataset`.
 */
export async function extendLoan(input: ExtendInput): Promise<boolean> {
  const { address, assertCurrent } = walletGuard();
  const prep = await fetch(`/api/loans/${input.loanId}/extend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rentalDays: input.rentalDays }),
  });
  if (!prep.ok) throw await responseError(prep, "Préparation de la prolongation échouée");
  const body = await prep.json() as PreparedLock;
  if (!body.loanId || !body.approveTransaction || !body.lockTransaction) {
    throw new Error(body.error ?? "Préparation de la prolongation échouée");
  }
  const extensionLoanId = body.loanId;
  assertCurrent();
  if (!body.billingQuote || await escrowBillingVersion() !== 7) throw new Error("Devis de prolongation absent ou incompatible avec l’escrow");
  const signedQuote = await verifyBorrowQuote(body.billingQuote, { loanId: extensionLoanId, datasetId: input.datasetId, borrower: address! });
  if (signedQuote.quote.extendsLoanId !== input.loanId || signedQuote.quote.rentalDays !== input.rentalDays) {
    throw new Error("Durée de location modifiée. Relance la prolongation.");
  }
  if (!await input.confirmQuote(signedQuote.quote)) return false;
  if (signedQuote.quote.expiresAt * 1000 <= Date.now()) throw new Error("Devis compute expiré");
  await approveAndLock(extensionLoanId, signedQuote, undefined, assertCurrent);
  const authorization = await issueRunnerGrant("extend-loan", { loanId: extensionLoanId }, [extensionLoanId, input.loanId]);
  const response = await fetch(`/api/loans/${input.loanId}/extend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extensionLoanId, authorization }),
  });
  const result = await response.json() as { error?: string; pending?: boolean };
  // Paiement acquis : l'attente de finalité (lock ou release) et un wallet runner occupé se résolvent
  // côté serveur, la prolongation s'applique alors d'elle-même.
  if (response.ok || result.error === EXTENSION_PENDING || result.error === SETTLEMENT_QUEUED) return true;
  throw new Error(result.error ?? "Prolongation échouée");
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

/**
 * Achète un pack de `size` appels API pour le prêt loué `loanId` (D-30) : prêt de pack préparé par
 * le serveur, devis accepté, même lock qu'un emprunt, puis `release` et crédit demandés au runner.
 * Renvoie `false` si le devis est refusé. Une fois le lock envoyé, tout ce qui reste (finalité,
 * wallet runner occupé, enclave en démarrage) se résout côté serveur : le reaper crédite le pack, une
 * seule fois. Avant tout paiement, un 503 `enclave_starting` remonte tel quel (`EnclaveStartingError`).
 */
export async function buyCalls(input: BuyCallsInput): Promise<boolean> {
  const { address, assertCurrent } = walletGuard();
  const prep = await fetch(`/api/loans/${input.loanId}/calls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ size: input.size }),
  });
  if (!prep.ok) throw await responseError(prep, "Préparation de l’achat d’appels échouée");
  const body = await prep.json() as PreparedLock;
  if (!body.loanId || !body.approveTransaction || !body.lockTransaction) throw new Error(body.error ?? "Préparation de l’achat d’appels échouée");
  const packLoanId = body.loanId;
  assertCurrent();
  if (!body.billingQuote || await escrowBillingVersion() !== 7) throw new Error("Devis du pack absent ou incompatible avec l’escrow");
  const signedQuote = await verifyBorrowQuote(body.billingQuote, { loanId: packLoanId, datasetId: input.datasetId, borrower: address! });
  if (signedQuote.quote.packForLoanId !== input.loanId || signedQuote.quote.callPack !== input.size || signedQuote.quote.extendsLoanId !== undefined) {
    throw new Error("Pack d’appels modifié. Relance l’achat.");
  }
  if (!await input.confirmQuote(signedQuote.quote)) return false;
  if (signedQuote.quote.expiresAt * 1000 <= Date.now()) throw new Error("Devis compute expiré");
  await approveAndLock(packLoanId, signedQuote, undefined, assertCurrent);
  const authorization = await issueRunnerGrant("buy-calls", { loanId: packLoanId }, [packLoanId, input.loanId]);
  const response = await fetch(`/api/loans/${input.loanId}/calls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packLoanId, authorization }),
  });
  if (response.ok) return true;
  const result = await response.clone().json().catch(() => ({})) as { error?: string | { code?: string } };
  // Paiement acquis : le reaper crédite le pack dès que possible, jamais deux fois.
  if (result.error === CALLS_PENDING || result.error === SETTLEMENT_QUEUED
    || (typeof result.error === "object" && result.error?.code === ENCLAVE_STARTING_CODE)) return true;
  throw await responseError(response, "Achat d’appels échoué");
}

interface RunLoanInput {
  loanId: string;
  datasetId: string;
  datasetReceipt: string;
  model: ModelSelection;
}

export async function runLoanJob(input: RunLoanInput): Promise<void> {
  const address = useWalletStore.getState().address;
  if (!address) throw new Error("Wallet déconnecté");
  const authorization = await issueRunnerGrant(
    "run-loan-job",
    { loanId: input.loanId, datasetId: input.datasetId },
    [
      input.loanId,
      input.datasetId,
      input.datasetReceipt,
      input.model.modelId,
      input.model.modelVersion,
      "served",
    ],
  );
  const response = await fetch(`/api/loans/${input.loanId}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authorization }),
  });
  const body = await response.json() as {
    modelCid?: string;
    runnerReceipt?: string;
    error?: string;
  };
  if (!response.ok || !body.modelCid || !body.runnerReceipt) {
    throw new Error(body.error ?? "Échec du job confidentiel");
  }
  await settleLoan(input.loanId, body.runnerReceipt);
}

/**
 * Attentes avant de redemander un règlement refusé parce qu'un autre occupe le wallet du runner
 * (`SETTLEMENT_QUEUED`, audit PAR-02). Chaque essai porte une nouvelle autorisation : le runner
 * refuse le rejeu d'un grant. Au-delà, le message s'affiche et le reaper reprend le prêt.
 */
export const SETTLEMENT_QUEUED_RETRY_MS = [2_000, 4_000, 8_000] as const;

/**
 * Relectures d'un règlement déjà envoyé, au palier rapide seulement (`SETTLEMENT_FINALITY_PENDING_FAST`) :
 * le réseau le confirme en général sous une minute. La page reste en « Règlement… » et ouvre la
 * prédiction dès la confirmation, au lieu d'afficher l'attente comme un échec et de laisser l'emprunteur
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

export async function resumeLoanSettlement(loanId: string, runnerReceipt: string): Promise<void> {
  const address = useWalletStore.getState().address;
  if (!address) throw new Error("Wallet déconnecté");
  await settleLoan(loanId, runnerReceipt);
}
