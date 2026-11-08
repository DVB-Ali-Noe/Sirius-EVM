"use client";

import { useWalletStore } from "@/stores/wallet";
import {
  API_ACCESS_PENDING,
  CALLS_PENDING,
  EXTENSION_PENDING,
  EXTENSION_SETTLEMENT_BUSY,
  PACK_SETTLEMENT_BUSY,
  SETTLEMENT_FINALITY_PENDING,
  SETTLEMENT_FINALITY_PENDING_FAST,
  SETTLEMENT_QUEUED,
} from "./settlement-status";
import {
  abortableSleep, ENCLAVE_STARTING_CODE, ENCLAVE_STARTING_MESSAGE, ENCLAVE_WAIT_MAX_MS, EnclaveStartingError, responseError,
} from "@/lib/train/enclave-wait";
import { apiAccessDatasetAmount, type CallPackSize } from "@/lib/billing/api-pricing";
import { sendActiveTransaction } from "@/lib/wallet/transaction-client";
import { guardRefundTransaction } from "@/lib/wallet/transaction-guard";
import { issueRunnerGrant } from "@/lib/runner/authorization-client";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
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
  /** Suivi du règlement que la page termine elle-même après le paiement. */
  settlement?: PaidSettlementOptions;
}

interface BuyCallsInput {
  /** Prêt loué d'origine, crédité du pack. */
  loanId: string;
  /** Dataset du prêt d'origine : le devis du pack doit le viser. */
  datasetId: string;
  size: CallPackSize;
  confirmQuote: (quote: ComputeQuote) => Promise<boolean>;
  /** Suivi du règlement que la page termine elle-même après le paiement. */
  settlement?: PaidSettlementOptions;
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
  // L'API incluse (D-32) est décidée par le serveur et affichée par le devis lui-même.
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
 * `false` si le devis est refusé. Une fois le lock envoyé, la page termine le règlement elle-même
 * (`finishPaidSettlement`) ; page fermée ou budget écoulé (`"deferred"`), le reaper l'applique seul.
 * Enclave à l'arrêt à la préparation : `EnclaveStartingError`, avant tout paiement, comme `borrowDataset`.
 */
export async function extendLoan(input: ExtendInput): Promise<PaidSettlement | false> {
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
  return finishPaidSettlement({
    url: `/api/loans/${input.loanId}/extend`,
    grant: () => issueRunnerGrant("extend-loan", { loanId: extensionLoanId }, [extensionLoanId, input.loanId]),
    body: (authorization) => ({ extensionLoanId, authorization }),
    failure: "Prolongation échouée",
  }, input.settlement);
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
 * Renvoie `false` si le devis est refusé. Une fois le lock envoyé, la page termine le règlement
 * elle-même (`finishPaidSettlement`) ; page fermée ou budget écoulé (`"deferred"`), le reaper crédite
 * le pack, une seule fois. Avant tout paiement, un 503 `enclave_starting` remonte tel quel
 * (`EnclaveStartingError`).
 */
export async function buyCalls(input: BuyCallsInput): Promise<PaidSettlement | false> {
  return buyLoanPack(input, { size: input.size });
}

/**
 * Achète le pass d'accès API (D-32) du prêt loué `loanId`, jusqu'à son échéance : même parcours
 * qu'un pack, jours comptés et signés par l'enclave dans le devis, couverture enregistrée une fois.
 */
export async function buyApiAccess(input: Omit<BuyCallsInput, "size">): Promise<PaidSettlement | false> {
  return buyLoanPack(input, { apiAccess: true });
}

async function buyLoanPack(
  input: Omit<BuyCallsInput, "size">,
  purchase: { size: CallPackSize } | { apiAccess: true },
): Promise<PaidSettlement | false> {
  const pass = "apiAccess" in purchase;
  const { address, assertCurrent } = walletGuard();
  const prep = await fetch(`/api/loans/${input.loanId}/calls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(purchase),
  });
  const preparationFailed = pass ? "Préparation de l’accès API échouée" : "Préparation de l’achat d’appels échouée";
  if (!prep.ok) throw await responseError(prep, preparationFailed);
  const body = await prep.json() as PreparedLock;
  if (!body.loanId || !body.approveTransaction || !body.lockTransaction) throw new Error(body.error ?? preparationFailed);
  const packLoanId = body.loanId;
  assertCurrent();
  if (!body.billingQuote || await escrowBillingVersion() !== 7) throw new Error("Devis du pack absent ou incompatible avec l’escrow");
  const signedQuote = await verifyBorrowQuote(body.billingQuote, { loanId: packLoanId, datasetId: input.datasetId, borrower: address! });
  const { quote } = signedQuote;
  if (quote.packForLoanId !== input.loanId || quote.extendsLoanId !== undefined
    || (pass ? quote.apiAccessDays === undefined || quote.callPack !== undefined || quote.maxFailureFee !== "0"
        || quote.datasetAmount !== apiAccessDatasetAmount(quote.usdcDecimals)
      : quote.callPack !== purchase.size || quote.apiAccessDays !== undefined)) {
    throw new Error("Pack d’appels modifié. Relance l’achat.");
  }
  if (!await input.confirmQuote(quote)) return false;
  if (quote.expiresAt * 1000 <= Date.now()) throw new Error("Devis compute expiré");
  await approveAndLock(packLoanId, signedQuote, undefined, assertCurrent);
  return finishPaidSettlement({
    url: `/api/loans/${input.loanId}/calls`,
    grant: () => issueRunnerGrant("buy-calls", { loanId: packLoanId }, [packLoanId, input.loanId]),
    body: (authorization) => ({ packLoanId, authorization }),
    failure: pass ? "Activation de l’accès API échouée" : "Achat d’appels échoué",
  }, input.settlement);
}

/**
 * Achat payé (pack, pass, prolongation) : tant qu'elle reste ouverte, la page termine elle-même le
 * règlement, un essai toutes les 10 s pendant au plus 3 min (palier rapide mesuré : environ 30 s).
 * Au plus 6 essais par minute, sous le quota de la route (10 par minute et par compte, partagé par
 * les packs et les passes) ; un refus de quota (429) attend simplement l'essai suivant. Au-delà, ou
 * page quittée, le reaper termine seul, après ses baux de sécurité.
 */
export const PAID_SETTLEMENT_RETRY_MS = 10_000;
export const PAID_SETTLEMENT_BUDGET_MS = 3 * 60_000;

/** Étape vue par la page : lock en attente de confirmation, puis `release` envoyé (activation). */
export type PaidSettlementStage = "confirming" | "activating";
/** Achat réglé depuis la page, ou laissé au reaper une fois le budget de la page écoulé. */
export type PaidSettlement = "settled" | "deferred";

/**
 * Avancement d'un règlement après paiement. L'attente de l'enclave y figure (`enclaveRetryInSeconds`)
 * au lieu de passer par l'attente d'avant paiement (`EnclaveStartingSteps`, « rien n'est payé »).
 */
export interface PaidSettlementProgress {
  stage: PaidSettlementStage;
  /** Enclave en démarrage : prochain essai dans ce délai ; `null` sinon. */
  enclaveRetryInSeconds: number | null;
}

export interface PaidSettlementOptions {
  /** Démontage du composant : plus aucun essai, l'attente en cours est coupée. */
  signal?: AbortSignal;
  /** Appelé au départ puis à chaque changement d'avancement. */
  onProgress?: (progress: PaidSettlementProgress) => void;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

interface PaidSettlementRequest {
  url: string;
  /** Autorisation neuve à chaque essai : le runner refuse le rejeu d'un grant (signé par la clé de session, sans wallet). */
  grant: () => Promise<RunnerGrant>;
  body: (authorization: RunnerGrant) => Record<string, unknown>;
  failure: string;
}

const PAID_SETTLEMENT_PENDING = new Set<string>([CALLS_PENDING, API_ACCESS_PENDING, EXTENSION_PENDING]);
// Un autre règlement occupe le wallet du runner ou détient le claim (reaper, autre onglet) : on réessaie.
const PAID_SETTLEMENT_BUSY = new Set<string>([SETTLEMENT_QUEUED, PACK_SETTLEMENT_BUSY, EXTENSION_SETTLEMENT_BUSY]);

/**
 * Rejoue le même règlement, idempotent côté serveur (claim sur `updatedAt`, journal du runner), tant
 * qu'il répond « en attente » (409 : lock pas encore confirmé ; 202 `pending` : `release` envoyé),
 * occupé, en quota, ou que le réseau du navigateur coupe. Enclave en démarrage : attente `Retry-After`,
 * comme `retryWhileEnclaveStarts`, dans le même budget, sans jamais remonter `EnclaveStartingError`
 * (l'appelant relancerait tout l'achat). Toute autre réponse est une erreur définitive, levée telle quelle.
 */
export async function finishPaidSettlement(
  request: PaidSettlementRequest,
  { signal, onProgress, wait = abortableSleep, now = () => Date.now() }: PaidSettlementOptions = {},
): Promise<PaidSettlement> {
  const deadline = now() + PAID_SETTLEMENT_BUDGET_MS;
  let progress: PaidSettlementProgress = { stage: "confirming", enclaveRetryInSeconds: null };
  onProgress?.(progress);
  const report = (next: PaidSettlementProgress) => {
    if (next.stage === progress.stage && next.enclaveRetryInSeconds === progress.enclaveRetryInSeconds) return;
    progress = next;
    onProgress?.(next);
  };
  for (;;) {
    signal?.throwIfAborted();
    const authorization = await request.grant();
    let response: Response | null = null;
    try {
      response = await fetch(request.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.body(authorization)),
        signal,
      });
    } catch (error) {
      // Réseau du navigateur coupé : l'essai suivant reprend, rien n'est perdu côté serveur.
      if (signal?.aborted) throw error;
    }
    let delayMs = PAID_SETTLEMENT_RETRY_MS;
    if (response?.ok) {
      const { pending } = await response.json().catch(() => ({})) as { pending?: unknown };
      if (response.status !== 202 && pending !== true) return "settled";
      report({ stage: "activating", enclaveRetryInSeconds: null });
    } else if (response) {
      const error = await responseError(response, request.failure);
      if (error instanceof EnclaveStartingError) {
        delayMs = error.retryAfterSeconds * 1000;
        report({ stage: progress.stage, enclaveRetryInSeconds: error.retryAfterSeconds });
      } else {
        report({ stage: progress.stage, enclaveRetryInSeconds: null });
        if (!PAID_SETTLEMENT_PENDING.has(error.message) && response.status !== 429 && !PAID_SETTLEMENT_BUSY.has(error.message)) {
          throw error;
        }
      }
    }
    if (now() + delayMs > deadline) return "deferred";
    await wait(delayMs, signal);
  }
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
  // CVM réveillée par la route : `EnclaveStartingError`, que l'appelant attend (`retryWhileEnclaveStarts`)
  // avant de relancer avec une nouvelle autorisation ; rien n'a été lancé ni écrit.
  if (!response.ok) throw await responseError(response, "Échec du job confidentiel");
  const body = await response.json() as { modelCid?: string; runnerReceipt?: string; error?: string };
  if (!body.modelCid || !body.runnerReceipt) throw new Error(body.error ?? "Échec du job confidentiel");
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
  let enclaveWaitMs = 0;
  for (;;) {
    const authorization = await grant("settle-loan", { loanId }, [loanId, runnerReceipt]);
    const response = await fetch(`/api/loans/${loanId}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorization }),
    });
    const body = await response.json() as { error?: unknown; pending?: boolean; code?: unknown; retryAfterSeconds?: unknown };
    const error = typeof body.error === "string" && body.error ? body.error : undefined;
    // Le serveur annonce l'attente selon le palier du prêt (secondes ou quart d'heure) ; sans message, l'attente longue.
    if (response.status === 202 && body.pending) {
      const message = error ?? SETTLEMENT_FINALITY_PENDING;
      if (message === SETTLEMENT_FINALITY_PENDING_FAST && pending < SETTLEMENT_PENDING_RETRY_MS.length) {
        await wait(SETTLEMENT_PENDING_RETRY_MS[pending++]);
        continue;
      }
      throw new Error(message);
    }
    if (response.status === 503 && error === SETTLEMENT_QUEUED && queued < SETTLEMENT_QUEUED_RETRY_MS.length) {
      await wait(SETTLEMENT_QUEUED_RETRY_MS[queued++]);
      continue;
    }
    // Enclave pas encore servie (la route ne réveille pas : le prêt la garde déjà voulue) : attente
    // `Retry-After` sur place, sans relancer l'entraînement, dans la limite d'`ENCLAVE_WAIT_MAX_MS`.
    if (response.status === 503 && body.code === ENCLAVE_STARTING_CODE) {
      const delayMs = (typeof body.retryAfterSeconds === "number" && body.retryAfterSeconds > 0 ? Math.min(body.retryAfterSeconds, 120) : 30) * 1000;
      if (enclaveWaitMs + delayMs <= ENCLAVE_WAIT_MAX_MS) {
        enclaveWaitMs += delayMs;
        await wait(delayMs);
        continue;
      }
      throw new Error(ENCLAVE_STARTING_MESSAGE);
    }
    if (!response.ok) throw new Error(error ?? "Règlement de l’escrow échoué");
    return;
  }
}

export async function resumeLoanSettlement(loanId: string, runnerReceipt: string): Promise<void> {
  const address = useWalletStore.getState().address;
  if (!address) throw new Error("Wallet déconnecté");
  await settleLoan(loanId, runnerReceipt);
}
