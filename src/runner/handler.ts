import "server-only";
import {
  escrowHashlock,
  escrowLock,
  evmLoanModelKey,
  runEvmLoanJob,
  runSelfTraining,
  selfTrainModelKey,
} from "@/lib/tee/core";
import { attestLoanExecution } from "@/lib/tee/attestation";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import { assertLoanScope, publishedPreimage, settleEscrow } from "@/lib/evm/escrow";
import { assertDatasetScope } from "@/lib/evm/dataset";
import { isValidUsdcAtomicAmount } from "@/lib/evm/usdc";
import { loanKeyFor } from "@/lib/evm/loan-key";
import { canonicalSubject } from "@/lib/subject";
import { modelSelection, type ModelSelection } from "@/lib/models/registry";
import { AppError } from "@/lib/app-error";
import { datasetIngressPublicKey } from "@/lib/tee/ingress";
import { sealDatasetEnvelope } from "@/lib/tee/core";
import { verifyRunnerGrant } from "@/lib/runner/authorization";
import {
  assertReleaseEnvelopeHash,
  issueDatasetReceipt,
  issueLoanReceipt,
  issueTrainingReceipt,
  verifyDatasetReceipt,
  verifyLoanReceipt,
  verifyTrainingReceipt,
} from "@/lib/runner/receipt";
import {
  encryptRunnerDelivery,
  encryptRunnerRelease,
  hashRunnerReleaseEnvelope,
} from "@/lib/runner/delivery";
import type { DatasetIngressEnvelope, DatasetRef } from "@/lib/tee/contract";
import { MAX_DATASET_BYTES } from "@/lib/tee/contract";
import type { RunnerOperation, RunnerScope } from "@/lib/runner/capability";

const MAX_ID_LENGTH = 128;
const MAX_CID_LENGTH = 256;
const MAX_WRAPPED_KEY_LENGTH = 1_024;
const MAX_RECEIPT_LENGTH = 8_192;

function text(body: Record<string, unknown>, key: string, maxLength = MAX_ID_LENGTH): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new AppError(`${key} invalide`, 400);
  }
  return value;
}

function boundedInteger(body: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new AppError(`${key} invalide`, 400);
  }
  return value as number;
}

function usdcAmount(body: Record<string, unknown>, key: string): string {
  const value = text(body, key, 26);
  if (!isValidUsdcAtomicAmount(value)) throw new AppError(`${key} invalide`, 400);
  return value;
}

function datasetRef(body: Record<string, unknown>): DatasetRef {
  return {
    datasetId: text(body, "datasetId"),
    cid: text(body, "cid", MAX_CID_LENGTH),
    wrappedKey: text(body, "wrappedKey", MAX_WRAPPED_KEY_LENGTH),
    merkleRoot: text(body, "merkleRoot", 128),
    priceUsdcAtomic: usdcAmount(body, "priceUsdcAtomic"),
    challengeDays: boundedInteger(body, "challengeDays", 1, 30),
  };
}

function trainingModel(body: Record<string, unknown>): ModelSelection {
  const selection = modelSelection(body.modelId, body.modelVersion);
  if (!selection) throw new AppError("Modèle ou version non autorisé", 400);
  return selection;
}

function ingressEnvelope(body: Record<string, unknown>): DatasetIngressEnvelope {
  const value = body.envelope;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("Enveloppe dataset manquante", 400);
  }
  return value as DatasetIngressEnvelope;
}

export function loanDeliveryContext(loanId: string, subject: string): string {
  return `loan:${canonicalSubject(subject)}:${loanId}`;
}

export function selfTrainDeliveryContext(jobId: string, owner: string): string {
  return `self-train:${canonicalSubject(owner)}:${jobId}`;
}

export function scopeForRunnerOp(op: string, body: Record<string, unknown>): { op: RunnerOperation; scope: RunnerScope } {
  switch (op) {
    case "dataset-ingress-key":
      return { op, scope: {} };
    case "seal-dataset":
      return { op, scope: { datasetId: text(body, "datasetId") } };
    case "escrow-hashlock":
      return { op, scope: { loanId: text(body, "loanId"), borrower: text(body, "borrower") } };
    case "run-loan-job":
      return { op, scope: { datasetId: text(body, "datasetId"), loanId: text(body, "loanId") } };
    case "settle-loan":
    case "loan-model-key":
      return { op, scope: { loanId: text(body, "loanId") } };
    case "run-training":
      return { op, scope: { datasetId: text(body, "datasetId"), jobId: text(body, "jobId") } };
    case "self-train-key":
      return { op, scope: { jobId: text(body, "jobId") } };
    default:
      throw new AppError("Opération runner inconnue", 404);
  }
}

export async function handleRunnerOp(op: RunnerOperation, body: Record<string, unknown>): Promise<unknown> {
  switch (op) {
    case "dataset-ingress-key":
      return datasetIngressPublicKey();

    case "seal-dataset": {
      const datasetId = text(body, "datasetId");
      const priceUsdcAtomic = usdcAmount(body, "priceUsdcAtomic");
      const challengeDays = boundedInteger(body, "challengeDays", 1, 30);
      const sizeBytes = boundedInteger(body, "sizeBytes", 1, MAX_DATASET_BYTES);
      const envelope = ingressEnvelope(body);
      const { subject } = await verifyRunnerGrant(body.authorization, {
        operation: op,
        datasetId,
        intentParts: [datasetId, priceUsdcAtomic, String(challengeDays), String(sizeBytes), envelope.ciphertext],
      });
      const result = await sealDatasetEnvelope(datasetId, envelope, sizeBytes);
      return {
        ...result,
        runnerReceipt: issueDatasetReceipt(subject, {
          datasetId,
          cid: result.cid,
          wrappedKey: result.wrappedKey,
          merkleRoot: result.merkleRoot,
          priceUsdcAtomic,
          challengeDays,
        }),
      };
    }

    case "escrow-hashlock":
      return { hashlock: escrowHashlock(text(body, "loanId"), canonicalSubject(text(body, "borrower"))) };

    case "run-loan-job": {
      const dataset = datasetRef(body);
      const loanId = text(body, "loanId");
      const model = trainingModel(body);
      const datasetReceiptToken = text(body, "datasetReceipt", MAX_RECEIPT_LENGTH);
      const deliveryPublicKey = text(body, "deliveryPublicKey", 200);
      const datasetReceipt = verifyDatasetReceipt(datasetReceiptToken, dataset);
      const { subject } = await verifyRunnerGrant(body.authorization, {
        operation: op,
        datasetId: dataset.datasetId,
        loanId,
        intentParts: [loanId, dataset.datasetId, datasetReceiptToken, deliveryPublicKey, model.modelId, model.modelVersion],
      });
      const borrower = canonicalSubject(subject);
      const loanKey = loanKeyFor(borrower, loanId);
      const { hashlock, preimage } = escrowLock(loanId, borrower);
      await Promise.all([
        assertDatasetScope({
          datasetId: dataset.datasetId,
          provider: datasetReceipt.owner,
          merkleRoot: dataset.merkleRoot,
          cid: dataset.cid,
        }),
        assertLoanScope({
          loanKey,
          borrower,
          provider: datasetReceipt.owner,
          datasetId: dataset.datasetId,
          amountUsdcAtomic: datasetReceipt.priceUsdcAtomic,
          hashlock,
        }),
      ]);

      const result = await runEvmLoanJob({ ...dataset, ...model, loanId, borrower });
      const releaseEnvelope = encryptRunnerRelease(
        evmLoanModelKey(loanId, borrower),
        deliveryPublicKey,
        loanDeliveryContext(loanId, borrower),
        preimage,
        "evm-preimage",
      );
      const { chainId, escrow } = evmEscrowBinding();
      const releaseEnvelopeHash = hashRunnerReleaseEnvelope(releaseEnvelope);
      const attestation = await attestLoanExecution({
        chainId,
        escrow,
        loanId,
        loanKey,
        datasetId: dataset.datasetId,
        datasetCid: dataset.cid,
        provider: datasetReceipt.owner,
        borrower,
        amountUsdcAtomic: datasetReceipt.priceUsdcAtomic,
        challengeDays: datasetReceipt.challengeDays,
        merkleRoot: dataset.merkleRoot,
        modelId: model.modelId,
        modelVersion: model.modelVersion,
        modelCid: result.modelCid,
        releaseEnvelopeHash,
      });
      return {
        modelCid: result.modelCid,
        metrics: result.metrics,
        attestation,
        loanKey,
        hashlock,
        releaseEnvelope,
        runnerReceipt: issueLoanReceipt({
          loanId,
          datasetId: dataset.datasetId,
          borrower,
          provider: datasetReceipt.owner,
          modelCid: result.modelCid,
          loanKey,
          chainId,
          escrow,
          amountUsdcAtomic: datasetReceipt.priceUsdcAtomic,
          challengeDays: datasetReceipt.challengeDays,
          modelId: model.modelId,
          modelVersion: model.modelVersion,
          deliveryPublicKey,
          releaseEnvelopeHash,
          attestationHash: attestation.payloadHash,
        }),
      };
    }

    case "settle-loan": {
      const loanId = text(body, "loanId");
      const loanReceiptToken = text(body, "loanReceipt", MAX_RECEIPT_LENGTH);
      const releaseEnvelopeHash = text(body, "releaseEnvelopeHash", 64);
      const receipt = verifyLoanReceipt(loanReceiptToken, loanId);
      assertReleaseEnvelopeHash(receipt, releaseEnvelopeHash);
      const { subject } = await verifyRunnerGrant(body.authorization, {
        operation: op,
        loanId,
        intentParts: [loanId, loanReceiptToken, releaseEnvelopeHash],
      });
      if (canonicalSubject(subject) !== receipt.borrower) throw new AppError("Règlement réservé au borrower", 403);
      const { preimage } = escrowLock(loanId, receipt.borrower);
      const lockBlock = BigInt(text(body, "lockBlock", 20));
      return { settleTxHash: await settleEscrow(receipt.loanKey as `0x${string}`, preimage, lockBlock) };
    }

    case "loan-model-key": {
      const loanId = text(body, "loanId");
      const loanReceiptToken = text(body, "loanReceipt", MAX_RECEIPT_LENGTH);
      const deliveryPublicKey = text(body, "deliveryPublicKey", 200);
      const receipt = verifyLoanReceipt(loanReceiptToken, loanId);
      const { subject } = await verifyRunnerGrant(body.authorization, {
        operation: op,
        loanId,
        intentParts: [loanId, loanReceiptToken, deliveryPublicKey],
      });
      if (canonicalSubject(subject) !== receipt.borrower) throw new AppError("Clé réservée au borrower", 403);
      await publishedPreimage(receipt.loanKey as `0x${string}`);
      return {
        modelCid: receipt.modelCid,
        modelKeyEnvelope: encryptRunnerDelivery(
          evmLoanModelKey(loanId, receipt.borrower),
          deliveryPublicKey,
          loanDeliveryContext(loanId, receipt.borrower),
        ),
      };
    }

    case "run-training": {
      const dataset = datasetRef(body);
      const jobId = text(body, "jobId");
      const model = trainingModel(body);
      const datasetReceiptToken = text(body, "datasetReceipt", MAX_RECEIPT_LENGTH);
      const datasetReceipt = verifyDatasetReceipt(datasetReceiptToken, dataset);
      const { subject } = await verifyRunnerGrant(body.authorization, {
        operation: op,
        datasetId: dataset.datasetId,
        jobId,
        intentParts: [dataset.datasetId, jobId, datasetReceiptToken, model.modelId, model.modelVersion],
      });
      if (canonicalSubject(subject) !== canonicalSubject(datasetReceipt.owner)) {
        throw new AppError("Self-train réservé au propriétaire", 403);
      }
      const result = await runSelfTraining({ ...dataset, ...model, jobId, owner: subject });
      return {
        ...result,
        runnerReceipt: issueTrainingReceipt({
          jobId,
          datasetId: dataset.datasetId,
          owner: subject,
          modelCid: result.modelCid,
          modelId: model.modelId,
          modelVersion: model.modelVersion,
        }),
      };
    }

    case "self-train-key": {
      const jobId = text(body, "jobId");
      const receipt = verifyTrainingReceipt(text(body, "jobReceipt", MAX_RECEIPT_LENGTH), jobId);
      const deliveryPublicKey = text(body, "deliveryPublicKey", 200);
      const { subject } = await verifyRunnerGrant(body.authorization, {
        operation: op,
        jobId,
        intentParts: [jobId, text(body, "jobReceipt", MAX_RECEIPT_LENGTH), deliveryPublicKey],
      });
      if (canonicalSubject(subject) !== canonicalSubject(receipt.owner)) throw new AppError("Clé réservée au propriétaire", 403);
      return {
        modelKeyEnvelope: encryptRunnerDelivery(
          selfTrainModelKey(jobId, receipt.owner),
          deliveryPublicKey,
          selfTrainDeliveryContext(jobId, receipt.owner),
        ),
      };
    }
  }
}
