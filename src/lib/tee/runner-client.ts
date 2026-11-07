import "server-only";
import { AppError } from "@/lib/app-error";
import { RunnerFinalityPending } from "@/lib/runner/failure-policy";
import { runnerEndpoint as endpoint } from "@/lib/runner/config";
import { issueRunnerCapability, type RunnerOperation, type RunnerScope } from "@/lib/runner/capability";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import type { ModelSelection } from "@/lib/models/registry";
import type {
  ApiKeySecretEnvelope,
  ApiModelInfo,
  ApiPrediction,
  ApiSignedRequest,
  AuthorizedSealDatasetResult,
  DatasetIngressEnvelope,
  DatasetIngressKey,
  DatasetRef,
  LoanJobResult,
  ModelRef,
  RecoveredLoanResult,
  SelfTrainingResult,
  SignedPrediction,
} from "./contract";
import { attestedRunnerFetch, runnerFailureDiagnostic } from "./ra-tls-client";
import type { LockAuthorization } from "@/lib/evm/lock-authorization";
import type { SignedComputeQuote } from "@/lib/billing/quote";
import type { CallPackSize } from "@/lib/billing/api-pricing";
import type { FinalityTier } from "@/lib/evm/fast-finality";

const RUNNER_TIMEOUT_MS = 60_000;

/**
 * Seule opération qu'un nouvel essai peut rejouer après une connexion keep-alive périmée
 * (ra-tls-client.ts, audit ROB-10) : la lecture de la clé publique d'ingestion. Ni scellement, ni
 * entraînement, ni verrou, ni règlement, ni prédiction (quota décompté) : une requête qui engage
 * un calcul, un paiement ou un règlement n'est jamais renvoyée par le client.
 */
export const RETRYABLE_RUNNER_OPS: ReadonlySet<RunnerOperation> = new Set(["dataset-ingress-key"]);

/**
 * Palier demandé à l'enclave, transmis seulement quand il est rapide : un prêt à finalité complète
 * envoie exactement la charge historique, et l'enclave lit « absent » comme `FULL`. Elle n'accorde
 * de toute façon le palier rapide qu'après sa propre vérification (fast-finality.ts).
 */
function finalityTierField(tier?: FinalityTier): { finalityTier?: FinalityTier } {
  return tier === "FAST" ? { finalityTier: "FAST" } : {};
}

export function usesRemoteRunner(): boolean {
  return endpoint() !== null;
}

async function callRunner<T>(op: RunnerOperation, scope: RunnerScope, payload: object): Promise<T> {
  const base = endpoint();
  if (!base) throw new Error("Runner distant non configuré");
  const url = new URL(op, `${base}/`);
  try {
    const headers = {
      "content-type": "application/json",
      "x-sirius-runner-capability": issueRunnerCapability(op, scope),
    };
    const response = url.protocol === "https:"
      ? await attestedRunnerFetch(url, {
        method: "POST", headers, body: JSON.stringify(payload), timeoutMs: RUNNER_TIMEOUT_MS, idempotent: RETRYABLE_RUNNER_OPS.has(op),
      })
      : await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS) });
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown; state?: unknown; transactionHash?: unknown } & T;
    if (response.status === 202 && body.state === "pending-finality"
      && typeof body.transactionHash === "string" && /^0x[0-9a-f]{64}$/i.test(body.transactionHash)) {
      throw new RunnerFinalityPending(body.transactionHash.toLowerCase());
    }
    if (!response.ok || response.status !== 200) {
      throw new AppError(typeof body.error === "string" ? body.error : "Runner confidentiel en échec", response.ok ? 502 : response.status,
        typeof body.code === "string" && /^[a-z_]{1,64}$/.test(body.code) ? body.code : undefined);
    }
    return body;
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Cause sans corps ni en-tête (code réseau, socket réutilisé, attestation) : distingue sur la
    // vraie CVM keep-alive, PCCS et identité derrière la même 503 (audit ROB-10, ROB-11).
    console.warn(`[runner-client] ${op} : runner injoignable, cause ${runnerFailureDiagnostic(error)}`);
    throw new AppError("Runner confidentiel indisponible", 503);
  }
}

async function dispatchRunner<T>(op: RunnerOperation, scope: RunnerScope, payload: Record<string, unknown>): Promise<T> {
  if (endpoint()) return callRunner(op, scope, payload);
  const { handleRunnerOp } = await import("@/runner/handler");
  return handleRunnerOp(op, payload) as Promise<T>;
}

export async function datasetIngressKeyInRunner(): Promise<DatasetIngressKey> {
  return dispatchRunner("dataset-ingress-key", {}, {});
}

export async function sealDatasetInRunner(
  datasetId: string,
  priceUsdcAtomic: string,
  challengeDays: number,
  sizeBytes: number,
  envelope: DatasetIngressEnvelope,
  authorization: RunnerGrant,
  model: ModelSelection,
  maxRentalDays: number,
): Promise<AuthorizedSealDatasetResult> {
  return dispatchRunner(
    "seal-dataset",
    { datasetId },
    { datasetId, priceUsdcAtomic, challengeDays, maxRentalDays, sizeBytes, envelope, authorization, ...model },
  );
}

/**
 * Durée de location choisie par l'emprunteur ; `extendsLoanId` pour un prêt de prolongation ;
 * `callPack` et `packForLoanId` (ensemble) pour un pack d'appels du prêt d'origine, dont il
 * reprend `rentalDays`.
 */
export interface LoanRentalRequest {
  rentalDays: number;
  extendsLoanId?: string;
  callPack?: CallPackSize;
  packForLoanId?: string;
}

export async function prepareEscrowLockInRunner(
  dataset: DatasetRef,
  datasetReceipt: string,
  loanId: string,
  borrower: string,
  authorizationDeadline: number,
  rental: LoanRentalRequest,
): Promise<{ hashlock: `0x${string}`; authorization: LockAuthorization; billingQuote?: SignedComputeQuote }> {
  return dispatchRunner("prepare-escrow-lock", { datasetId: dataset.datasetId, loanId, borrower },
    { ...dataset, datasetReceipt, loanId, borrower, authorizationDeadline, rentalDays: rental.rentalDays,
      ...(rental.extendsLoanId === undefined ? {} : { extendsLoanId: rental.extendsLoanId }),
      ...(rental.callPack === undefined ? {} : { callPack: rental.callPack }),
      ...(rental.packForLoanId === undefined ? {} : { packForLoanId: rental.packForLoanId }) });
}

export async function runLoanJobInRunner(
  input: Omit<DatasetRef, "datasetId"> & ModelSelection & { datasetId: string; loanId: string },
  datasetReceipt: string,
  authorization: RunnerGrant,
  billingQuote?: SignedComputeQuote,
  finalityTier?: FinalityTier,
): Promise<LoanJobResult> {
  return dispatchRunner(
    "run-loan-job",
    { datasetId: input.datasetId, loanId: input.loanId },
    { ...input, datasetReceipt, authorization, ...(billingQuote ? { billingQuote } : {}), ...finalityTierField(finalityTier) },
  );
}

export async function settleLoanInRunner(
  loanId: string,
  loanReceipt: string,
  lockBlock: string,
  authorization?: RunnerGrant,
  finalityTier?: FinalityTier,
): Promise<{ settleTxHash: string; expiresAt?: number }> {
  return dispatchRunner(
    "settle-loan",
    { loanId },
    { loanId, loanReceipt, lockBlock, ...(authorization ? { authorization } : {}), ...finalityTierField(finalityTier) },
  );
}

/**
 * Prolongation d'une location : `loanReceipt` est le reçu du prêt d'ORIGINE, `billingQuote` le devis
 * du prêt de prolongation, verrouillé au bloc `lockBlock`. Le runner libère ce lock sans
 * entraînement et renvoie l'échéance en vigueur du prêt d'origine (ms epoch). Rejouable.
 */
export async function extendLoanInRunner(input: {
  loanId: string;
  originalLoanId: string;
  loanReceipt: string;
  billingQuote: SignedComputeQuote;
  lockBlock: string;
  authorization?: RunnerGrant;
  finalityTier?: FinalityTier;
}): Promise<{ settleTxHash: string; expiresAt: number }> {
  const { authorization, finalityTier, ...payload } = input;
  return dispatchRunner(
    "extend-loan",
    { loanId: input.loanId },
    { ...payload, ...(authorization ? { authorization } : {}), ...finalityTierField(finalityTier) },
  );
}

export async function recoverLoanJobInRunner(loanId: string, billingQuote: SignedComputeQuote): Promise<RecoveredLoanResult> {
  return dispatchRunner("recover-loan-job", { loanId }, { loanId, billingQuote });
}

/**
 * Pack d'appels (D-30) : `loanId` est le prêt de pack verrouillé au bloc `lockBlock`,
 * `loanReceipt` le reçu du prêt d'ORIGINE. Le runner libère ce lock sans entraînement et crédite
 * `callPack` appels au prêt d'origine une seule fois ; renvoie le solde de crédits. Rejouable.
 */
export async function buyCallsInRunner(input: {
  loanId: string;
  originalLoanId: string;
  loanReceipt: string;
  billingQuote: SignedComputeQuote;
  lockBlock: string;
  authorization?: RunnerGrant;
  finalityTier?: FinalityTier;
}): Promise<{ settleTxHash: string; credits: number }> {
  const { authorization, finalityTier, ...payload } = input;
  return dispatchRunner(
    "buy-calls",
    { loanId: input.loanId },
    { ...payload, ...(authorization ? { authorization } : {}), ...finalityTierField(finalityTier) },
  );
}

/** Self-train : toujours scellé dans le runner, pour les trois profils. */
export async function runSelfTrainingInRunner(
  input: Omit<DatasetRef, "datasetId"> & ModelSelection & { datasetId: string; jobId: string },
  datasetReceipt: string,
  authorization: RunnerGrant,
): Promise<SelfTrainingResult> {
  return dispatchRunner(
    "run-training",
    { datasetId: input.datasetId, jobId: input.jobId },
    { ...input, datasetReceipt, authorization },
  );
}

/** Preuve de règlement d'un prêt, exigée par le runner avant toute prédiction sur son modèle. */
export interface LoanPredictionContext {
  loanReceipt: string;
  settleTxHash: string;
  finalityTier?: FinalityTier;
}

export async function predictInRunner(
  ref: ModelRef,
  features: Record<string, number>,
  authorization: RunnerGrant,
  loanContext?: LoanPredictionContext,
): Promise<SignedPrediction> {
  if ((ref.kind === "loan") !== Boolean(loanContext)) throw new AppError("Contexte de prêt invalide", 400);
  const scope = ref.kind === "job" ? { jobId: ref.id } : { loanId: ref.id };
  const loan = loanContext ? { loanReceipt: loanContext.loanReceipt, settleTxHash: loanContext.settleTxHash } : {};
  const finalityTier = loanContext?.finalityTier;
  return dispatchRunner("predict", scope, { modelRef: ref, features, authorization, ...loan, ...finalityTierField(finalityTier) });
}

/**
 * Clé API d'un prêt réglé (D-30) : `envelope` chiffre le secret pour l'enclave
 * (`encryptApiKeySecretForRunner`) ; le grant wallet porte `[loanId, keyId, apiKeyEnvelopeSha256]`.
 * Renvoie la date de création (ms epoch), jamais le secret.
 */
export async function registerApiKeyInRunner(input: {
  loanId: string;
  keyId: string;
  envelope: ApiKeySecretEnvelope;
  loanReceipt: string;
  settleTxHash: string;
  authorization: RunnerGrant;
  finalityTier?: FinalityTier;
}): Promise<{ keyId: string; createdAt: number }> {
  const { finalityTier, ...payload } = input;
  return dispatchRunner("register-api-key", { loanId: input.loanId }, { ...payload, ...finalityTierField(finalityTier) });
}

export async function revokeApiKeyInRunner(input: {
  loanId: string;
  keyId: string;
  authorization: RunnerGrant;
}): Promise<{ keyId: string; revokedAt: number }> {
  return dispatchRunner("revoke-api-key", { loanId: input.loanId }, { ...input });
}

/** Requête signée relayée telle quelle, avec la preuve de règlement du prêt lue en base. */
export type ApiRunnerRequest = ApiSignedRequest & LoanPredictionContext & { loanId: string };

/** Prédiction par clé API : le runner vérifie la signature HMAC du client ; Next ne peut pas en fabriquer. */
export async function apiPredictInRunner(input: ApiRunnerRequest): Promise<ApiPrediction> {
  const { finalityTier, ...payload } = input;
  return dispatchRunner("api-predict", { loanId: input.loanId }, { ...payload, ...finalityTierField(finalityTier) });
}

/** Description du modèle et appels restants (`GET`, corps vide) ; ne consomme aucun quota. */
export async function apiInfoInRunner(input: ApiRunnerRequest): Promise<ApiModelInfo> {
  const { finalityTier, ...payload } = input;
  return dispatchRunner("api-info", { loanId: input.loanId }, { ...payload, ...finalityTierField(finalityTier) });
}

/** État d'un scellement en morceaux, tel que le runner le renvoie (voir `src/runner/chunked-seal-jobs.ts`). */
export type ChunkedSealStatus =
  | { state: "sealing"; startedAt: number }
  | { state: "sealed"; result: AuthorizedSealDatasetResult }
  | { state: "failed"; error: string; status: number; retryable: boolean };

/**
 * Lance le scellement d'un dataset envoyé en morceaux dans R2 (jusqu'à 1 Gio). Le runner rend la
 * main tout de suite ; l'état se lit ensuite avec `chunkedSealStatusInRunner`.
 */
export async function startChunkedSealInRunner(input: {
  datasetId: string;
  uploadId: string;
  priceUsdcAtomic: string;
  challengeDays: number;
  maxRentalDays: number;
  sizeBytes: number;
  manifest: unknown;
  authorization: RunnerGrant;
  model: ModelSelection;
}): Promise<ChunkedSealStatus> {
  const { model, ...rest } = input;
  return dispatchRunner("seal-chunked-dataset", { datasetId: input.datasetId }, { ...rest, ...model });
}

export async function chunkedSealStatusInRunner(datasetId: string, uploadId: string): Promise<ChunkedSealStatus> {
  return dispatchRunner("seal-chunked-status", { datasetId }, { datasetId, uploadId });
}
