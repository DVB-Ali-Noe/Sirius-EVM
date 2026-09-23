import "server-only";
import { AppError } from "@/lib/app-error";
import { runnerEndpoint as endpoint } from "@/lib/runner/config";
import { issueRunnerCapability, type RunnerOperation, type RunnerScope } from "@/lib/runner/capability";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import type { ModelSelection } from "@/lib/models/registry";
import type { LoanExecutionAttestation } from "./types";
import type {
  AuthorizedSealDatasetResult,
  AuthorizedTrainingResult,
  DatasetIngressEnvelope,
  DatasetIngressKey,
  DatasetRef,
  RunnerDeliveryEnvelope,
  RunnerReleaseEnvelope,
} from "./contract";
import { attestedRunnerFetch } from "./ra-tls-client";
import type { LockAuthorization } from "@/lib/evm/lock-authorization";
import type { SignedComputeQuote } from "@/lib/billing/quote";

const RUNNER_TIMEOUT_MS = 60_000;

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
      ? await attestedRunnerFetch(url, { method: "POST", headers, body: JSON.stringify(payload), timeoutMs: RUNNER_TIMEOUT_MS })
      : await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS) });
    const body = (await response.json().catch(() => ({}))) as { error?: unknown } & T;
    if (!response.ok) throw new AppError(typeof body.error === "string" ? body.error : "Runner confidentiel en échec", response.status);
    return body;
  } catch (error) {
    if (error instanceof AppError) throw error;
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
): Promise<AuthorizedSealDatasetResult> {
  return dispatchRunner(
    "seal-dataset",
    { datasetId },
    { datasetId, priceUsdcAtomic, challengeDays, sizeBytes, envelope, authorization, ...model },
  );
}

export async function prepareEscrowLockInRunner(
  dataset: DatasetRef,
  datasetReceipt: string,
  loanId: string,
  borrower: string,
  authorizationDeadline: number,
): Promise<{ hashlock: `0x${string}`; authorization: LockAuthorization; billingQuote?: SignedComputeQuote }> {
  return dispatchRunner("prepare-escrow-lock", { datasetId: dataset.datasetId, loanId, borrower },
    { ...dataset, datasetReceipt, loanId, borrower, authorizationDeadline });
}

export async function runLoanJobInRunner(
  input: Omit<DatasetRef, "datasetId"> & ModelSelection & { datasetId: string; loanId: string },
  datasetReceipt: string,
  deliveryPublicKey: string,
  authorization: RunnerGrant,
  billingQuote?: SignedComputeQuote,
): Promise<{
  modelCid: string;
  metrics: Record<string, number>;
  attestation: LoanExecutionAttestation;
  releaseEnvelope?: RunnerReleaseEnvelope;
  releaseEnvelopeHash: string;
  runnerReceipt: string;
}> {
  return dispatchRunner(
    "run-loan-job",
    { datasetId: input.datasetId, loanId: input.loanId },
    { ...input, datasetReceipt, deliveryPublicKey, authorization, ...(billingQuote ? { billingQuote } : {}) },
  );
}

export async function settleLoanInRunner(
  loanId: string,
  loanReceipt: string,
  releaseEnvelopeHash: string,
  lockBlock: string,
  authorization?: RunnerGrant,
): Promise<{ settleTxHash: string }> {
  return dispatchRunner(
    "settle-loan",
    { loanId },
    { loanId, loanReceipt, releaseEnvelopeHash, lockBlock, ...(authorization ? { authorization } : {}) },
  );
}

export async function loanModelKeyInRunner(
  loanId: string,
  loanReceipt: string,
  deliveryPublicKey: string,
  authorization: RunnerGrant,
  settleTxHash?: string,
): Promise<{ modelCid: string; modelKeyEnvelope: RunnerDeliveryEnvelope }> {
  return dispatchRunner(
    "loan-model-key",
    { loanId },
    { loanId, loanReceipt, deliveryPublicKey, authorization, ...(settleTxHash ? { settleTxHash } : {}) },
  );
}

export async function runSelfTrainingInRunner(
  input: Omit<DatasetRef, "datasetId"> & ModelSelection & { datasetId: string; jobId: string },
  datasetReceipt: string,
  authorization: RunnerGrant,
): Promise<AuthorizedTrainingResult> {
  return dispatchRunner(
    "run-training",
    { datasetId: input.datasetId, jobId: input.jobId },
    { ...input, datasetReceipt, authorization },
  );
}

export async function selfTrainModelKeyInRunner(
  jobId: string,
  jobReceipt: string,
  deliveryPublicKey: string,
  authorization: RunnerGrant,
): Promise<RunnerDeliveryEnvelope> {
  const out = await dispatchRunner<{ modelKeyEnvelope: RunnerDeliveryEnvelope }>(
    "self-train-key",
    { jobId },
    { jobId, jobReceipt, deliveryPublicKey, authorization },
  );
  return out.modelKeyEnvelope;
}
