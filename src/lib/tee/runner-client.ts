import "server-only";
import { AppError } from "@/lib/app-error";
import { isDemoDeployment } from "@/lib/deployment-mode";
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

const RUNNER_TIMEOUT_MS = 60_000;

function endpoint(): string | null {
  const configured = process.env.RUNNER_URL?.trim();
  if (!configured) {
    // Sans runner distant, l'appelant exécute la logique confidentielle dans son
    // propre processus. C'est le chemin de développement, et c'est aussi celui de la
    // démonstration : tant qu'aucune enclave n'existe, un runner séparé n'apporterait
    // qu'un saut réseau devant le même calcul non attesté.
    //
    // Le mode démonstration est refusé sur mainnet par `instrumentation-node.ts`, donc
    // ce chemin ne peut jamais servir de l'argent réel.
    if (process.env.NODE_ENV === "production" && !isDemoDeployment()) {
      throw new Error("RUNNER_URL obligatoire en production");
    }
    return null;
  }
  const url = new URL(configured);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("RUNNER_URL doit cibler l’origine racine du runner");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Protocole RUNNER_URL invalide");
  // Un runner DISTANT reste soumis au régime strict, même en démonstration : dès
  // qu'un secret traverse le réseau, il lui faut du TLS et une enclave attestée en
  // face. L'assouplissement ci-dessus ne concerne que le cas sans réseau du tout.
  if (process.env.NODE_ENV === "production" && (url.protocol !== "https:" || process.env.TEE_MODE !== "phala")) {
    throw new Error("Runner production : HTTPS et TEE_MODE=phala obligatoires");
  }
  return url.toString().replace(/\/+$/, "");
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

export async function escrowHashlockInRunner(loanId: string, borrower: string): Promise<`0x${string}`> {
  const out = await dispatchRunner<{ hashlock: `0x${string}` }>(
    "escrow-hashlock",
    { loanId, borrower },
    { loanId, borrower },
  );
  return out.hashlock;
}

export async function runLoanJobInRunner(
  input: Omit<DatasetRef, "datasetId"> & ModelSelection & { datasetId: string; loanId: string },
  datasetReceipt: string,
  deliveryPublicKey: string,
  authorization: RunnerGrant,
): Promise<{
  modelCid: string;
  metrics: Record<string, number>;
  attestation: LoanExecutionAttestation;
  releaseEnvelope: RunnerReleaseEnvelope;
  runnerReceipt: string;
}> {
  return dispatchRunner(
    "run-loan-job",
    { datasetId: input.datasetId, loanId: input.loanId },
    { ...input, datasetReceipt, deliveryPublicKey, authorization },
  );
}

export async function settleLoanInRunner(
  loanId: string,
  loanReceipt: string,
  releaseEnvelopeHash: string,
  lockBlock: string,
  authorization: RunnerGrant,
): Promise<{ settleTxHash: string }> {
  return dispatchRunner(
    "settle-loan",
    { loanId },
    { loanId, loanReceipt, releaseEnvelopeHash, lockBlock, authorization },
  );
}

export async function loanModelKeyInRunner(
  loanId: string,
  loanReceipt: string,
  deliveryPublicKey: string,
  authorization: RunnerGrant,
): Promise<{ modelCid: string; modelKeyEnvelope: RunnerDeliveryEnvelope }> {
  return dispatchRunner(
    "loan-model-key",
    { loanId },
    { loanId, loanReceipt, deliveryPublicKey, authorization },
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
