import "server-only";
import { AppError } from "@/lib/app-error";
import { issueRunnerCapability, type RunnerOperation, type RunnerScope } from "@/lib/runner/capability";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import type {
  AuthorizedSealDatasetResult,
  AuthorizedTrainingResult,
  DatasetIngressEnvelope,
  DatasetIngressKey,
  EscrowCondition,
  LoanJobInput,
  RunnerDeliveryEnvelope,
  RunnerEscrowReconciliation,
  RunnerReleaseEnvelope,
  SelfTrainingInput,
} from "./contract";
import type { PreparedLoanJobResult } from "./types";
import { attestedRunnerFetch } from "./ra-tls-client";

const RUNNER_TIMEOUT_MS = 60_000;

function endpoint(): string | null {
  const configured = process.env.RUNNER_URL?.trim();
  if (configured) {
    const url = new URL(configured);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("RUNNER_URL doit cibler l’origine racine du runner");
    }
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
      throw new Error("RUNNER_URL doit utiliser HTTPS en production");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Protocole RUNNER_URL invalide");
    }
    if (process.env.NODE_ENV === "production" && process.env.TEE_MODE !== "phala") {
      throw new Error("TEE_MODE=phala obligatoire avec le runner de production");
    }
    return url.toString().replace(/\/+$/, "");
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("RUNNER_URL obligatoire en production");
  }
  return null;
}

export function usesRemoteRunner(): boolean {
  return !!process.env.RUNNER_URL?.trim();
}

async function callRunner<T>(op: RunnerOperation, scope: RunnerScope, payload: object): Promise<T> {
  const base = endpoint();
  if (!base) throw new Error("Runner distant non configuré");

  let response: Response;
  try {
    const url = new URL(op, `${base}/`);
    const body = JSON.stringify(payload);
    const headers = {
      "content-type": "application/json",
      "x-sirius-runner-capability": issueRunnerCapability(op, scope),
    };
    response = url.protocol === "https:"
      ? await attestedRunnerFetch(url, {
          method: "POST",
          headers,
          body,
          timeoutMs: RUNNER_TIMEOUT_MS,
        })
      : await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS),
    });
  } catch {
    throw new AppError("Runner confidentiel indisponible", 503);
  }

  const body = (await response.json().catch(() => ({}))) as { error?: unknown } & T;
  if (!response.ok) {
    throw new AppError(typeof body.error === "string" ? body.error : "Runner confidentiel en échec", response.status);
  }
  return body;
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
  priceDrops: string,
  challengeDays: number,
  sizeBytes: number,
  envelope: DatasetIngressEnvelope,
  authorization: RunnerGrant,
): Promise<AuthorizedSealDatasetResult> {
  return dispatchRunner(
    "seal-dataset",
    { datasetId },
    { datasetId, priceDrops, challengeDays, sizeBytes, envelope, authorization },
  );
}

export async function runSelfTrainingInRunner(
  input: Omit<SelfTrainingInput, "owner">,
  datasetReceipt: string,
  authorization: RunnerGrant,
): Promise<AuthorizedTrainingResult> {
  return dispatchRunner(
    "run-training",
    { datasetId: input.datasetId, jobId: input.jobId },
    { ...input, datasetReceipt, authorization },
  );
}

export async function runLoanJobInRunner(
  input: Omit<LoanJobInput, "borrower">,
  proof: {
    datasetReceipt: string;
    escrowTxHash: string;
    escrowSequence: number;
    deliveryPublicKey: string;
  },
  authorization: RunnerGrant,
): Promise<PreparedLoanJobResult> {
  return dispatchRunner(
    "run-loan-job",
    { datasetId: input.datasetId, loanId: input.loanId },
    { ...input, ...proof, authorization },
  );
}

export async function prepareLoanDeliveryInRunner(
  loanId: string,
  loanReceipt: string,
  deliveryPublicKey: string,
  authorization: RunnerGrant,
): Promise<{ runnerReceipt: string; releaseEnvelope: RunnerReleaseEnvelope }> {
  return dispatchRunner(
    "prepare-loan-delivery",
    { loanId },
    { loanId, loanReceipt, deliveryPublicKey, authorization },
  );
}

export async function settleLoanInRunner(
  loanId: string,
  loanReceipt: string,
  releaseEnvelopeHash: string,
  authorization: RunnerGrant,
): Promise<{ settleTxHash: string; auditTxHash: string | null }> {
  return dispatchRunner<{ settleTxHash: string; auditTxHash: string | null }>(
    "settle-loan",
    { loanId },
    { loanId, loanReceipt, releaseEnvelopeHash, authorization },
  );
}

export async function reconcileLoanEscrowInRunner(input: {
  loanId: string;
  borrower: string;
  escrowTxHash: string;
  escrowSequence: number;
  loanReceipt?: string;
}): Promise<RunnerEscrowReconciliation> {
  return dispatchRunner(
    "reconcile-loan-escrow",
    { loanId: input.loanId, borrower: input.borrower },
    input,
  );
}

export async function loanModelKeyInRunner(
  loanId: string,
  loanReceipt: string,
  settleTxHash: string,
  deliveryPublicKey: string,
  authorization: RunnerGrant,
): Promise<RunnerDeliveryEnvelope> {
  const out = await dispatchRunner<{ modelKeyEnvelope: RunnerDeliveryEnvelope }>(
    "loan-model-key",
    { loanId },
    { loanId, loanReceipt, settleTxHash, deliveryPublicKey, authorization },
  );
  return out.modelKeyEnvelope;
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

export async function escrowConditionInRunner(loanId: string, borrower: string): Promise<EscrowCondition> {
  const out = await dispatchRunner<{ conditionHex: string }>(
    "escrow-condition",
    { loanId, borrower },
    { loanId, borrower },
  );
  return { conditionHex: out.conditionHex, fulfillmentHex: "" };
}
