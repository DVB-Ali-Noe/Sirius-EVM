import "server-only";
import { createHash } from "node:crypto";
import {
  sealDatasetEnvelope,
  runSelfTraining,
  loanModelKey,
  selfTrainModelKey,
  escrowConditionPublic,
  escrowRelease,
  escrowHashlock,
  escrowLock,
  evmLoanModelKey,
  runEvmLoanJob,
} from "@/lib/tee/core";
import { attest } from "@/lib/tee/attestation";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import { assertLoanScope, reconcileLoanEscrow, settleEscrow } from "@/lib/evm/escrow";
import { loanKeyFor } from "@/lib/evm/loan-key";
import { isValidWeiAmount } from "@/lib/evm/amount";
import { canonicalSubject } from "@/lib/subject";
import { AppError } from "@/lib/app-error";
import { getTeeRunner } from "@/lib/tee";
import { datasetIngressPublicKey } from "@/lib/tee/ingress";
import { verifyRunnerGrant } from "@/lib/runner/authorization";
import {
  issueDatasetReceipt,
  issueLoanReceipt,
  issueTrainingReceipt,
  assertLoanReleaseEnvelopeHash,
  assertEvmReleaseEnvelopeHash,
  issueEvmLoanReceipt,
  verifyEvmLoanReceipt,
  verifyDatasetReceipt,
  verifyLoanReceipt,
  verifyTrainingReceipt,
} from "@/lib/runner/receipt";
import { verifyEscrowCreateProof, verifyEscrowFinishProof } from "@/lib/runner/xrpl-proof";
import {
  encryptRunnerDelivery,
  encryptRunnerRelease,
  hashRunnerReleaseEnvelope,
} from "@/lib/runner/delivery";
import {
  reconcileLoanEscrowInRunner,
  settleEscrowInRunner,
} from "@/lib/runner/settlement";
import { recordAuditReceipt } from "./audit";
import type {
  DatasetIngressEnvelope,
  DatasetRef,
  LoanJobInput,
  SelfTrainingInput,
} from "@/lib/tee/contract";
import { MAX_DATASET_BYTES } from "@/lib/tee/contract";
import type { RunnerOperation, RunnerScope } from "@/lib/runner/capability";

/**
 * Dispatch des opérations confidentielles du runner (inc.3d-B.2). Pur : ne connaît ni HTTP ni
 * auth (portés par server.ts). Chaque op mappe le contrat `tee/contract` + `tee/core`, seul
 * détenteur de la master key enclave. Le fulfillment ne sort jamais de ce process avant sa
 * publication dans l'`EscrowFinish`.
 *
 * ⚠ SÉCURITÉ : jamais d'endpoint dérivant une clé depuis un `keyContext` LIBRE — ce serait un
 * oracle universel sur la master key (reconstruction du fulfillment `escrow:*`, de la clé HMAC
 * d'attestation, des KEK `wrap:dataset:*` → déchiffrement de tout dataset). La livraison de clé
 * est scopée aux SEULS livrables (clé du modèle), le contexte étant reconstruit ICI depuis un id.
 */
/**
 * Contexte de livraison d'une capsule. Il sert simultanément d'AAD pour l'AES-GCM et
 * de suffixe d'`info` HKDF, donc il doit être **identique octet pour octet** entre le
 * runner et le navigateur. Le passer par `canonicalSubject` des deux côtés supprime la
 * seule divergence possible : la casse d'une adresse EVM. Sans cela, une capsule
 * scellée sous `0xAbC…` et relue sous `0xabc…` échoue à l'authentification GCM, ce qui
 * est indiscernable d'une corruption.
 */
export function loanDeliveryContext(loanId: string, subject: string): string {
  return `loan:${canonicalSubject(subject)}:${loanId}`;
}

export function selfTrainDeliveryContext(jobId: string, owner: string): string {
  return `self-train:${canonicalSubject(owner)}:${jobId}`;
}

const MAX_ID_LENGTH = 128;
const MAX_CID_LENGTH = 256;
const MAX_WRAPPED_KEY_LENGTH = 1_024;
const MAX_MERKLE_ROOT_LENGTH = 128;
const MAX_RECEIPT_LENGTH = 8_192;
// Un hash XRPL fait 64 caractères hexadécimaux ; un hash EVM en fait 66, préfixe `0x`
// compris. Plafonner à 64 rejetterait tout hash EVM — et le ferait au pire endroit :
// `loan-model-key` s'exécute APRÈS que le règlement a publié le préimage de façon
// irréversible. Le borrower aurait payé, le secret serait public, et la livraison de
// la clé du modèle échouerait sur une longueur.
const MAX_TX_HASH_LENGTH = 66;

function text(body: Record<string, unknown>, key: string, maxLength = MAX_ID_LENGTH): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new AppError(`${key} invalide`, 400);
  }
  return value;
}

function datasetRef(body: Record<string, unknown>): DatasetRef {
  return {
    datasetId: text(body, "datasetId"),
    cid: text(body, "cid", MAX_CID_LENGTH),
    wrappedKey: text(body, "wrappedKey", MAX_WRAPPED_KEY_LENGTH),
    merkleRoot: text(body, "merkleRoot", MAX_MERKLE_ROOT_LENGTH),
    priceDrops: drops(body, "priceDrops"),
    challengeDays: boundedInteger(body, "challengeDays", 1, 30),
    ...(body.priceWei === undefined ? {} : { priceWei: wei(body, "priceWei") }),
  };
}

/** Montant en wei, validé et borné comme le prix côté application. */
function wei(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (!isValidWeiAmount(value)) throw new AppError(`${key} invalide`, 400);
  return value;
}

function integer(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new AppError(`${key} invalide`, 400);
  return value as number;
}

function boundedInteger(body: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
  const value = integer(body, key);
  if (value < minimum || value > maximum) throw new AppError(`${key} invalide`, 400);
  return value;
}

function drops(body: Record<string, unknown>, key: string): string {
  const value = text(body, key, 16);
  if (!/^[0-9]+$/.test(value)) throw new AppError(`${key} invalide`, 400);
  const amount = BigInt(value);
  if (amount < BigInt(1_000) || amount > BigInt(1_000_000_000_000)) {
    throw new AppError(`${key} invalide`, 400);
  }
  return value;
}

function ingressEnvelope(body: Record<string, unknown>): DatasetIngressEnvelope {
  const value = body.envelope;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("Enveloppe dataset manquante", 400);
  }
  return value as DatasetIngressEnvelope;
}

export function scopeForRunnerOp(op: string, body: Record<string, unknown>): { op: RunnerOperation; scope: RunnerScope } {
  switch (op) {
    case "dataset-ingress-key":
      return { op, scope: {} };
    case "seal-dataset":
      return { op, scope: { datasetId: text(body, "datasetId") } };
    case "run-loan-job":
      return { op, scope: { datasetId: text(body, "datasetId"), loanId: text(body, "loanId") } };
    case "prepare-loan-delivery":
    case "settle-loan":
      return { op, scope: { loanId: text(body, "loanId") } };
    case "reconcile-loan-escrow":
      return {
        op,
        scope: { loanId: text(body, "loanId"), borrower: text(body, "borrower") },
      };
    case "run-training":
      return { op, scope: { datasetId: text(body, "datasetId"), jobId: text(body, "jobId") } };
    case "loan-model-key":
      return { op, scope: { loanId: text(body, "loanId") } };
    case "escrow-condition":
      return {
        op,
        scope: { loanId: text(body, "loanId"), borrower: text(body, "borrower") },
      };
    case "self-train-key":
      return { op, scope: { jobId: text(body, "jobId") } };
    case "evm-escrow-hashlock":
      return {
        op,
        scope: { loanId: text(body, "loanId"), borrower: text(body, "borrower") },
      };
    case "evm-run-loan-job":
      return { op, scope: { datasetId: text(body, "datasetId"), loanId: text(body, "loanId") } };
    case "evm-settle-loan":
    case "evm-loan-model-key":
      return { op, scope: { loanId: text(body, "loanId") } };
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
      const priceDrops = drops(body, "priceDrops");
      const challengeDays = boundedInteger(body, "challengeDays", 1, 30);
      const sizeBytes = boundedInteger(body, "sizeBytes", 1, MAX_DATASET_BYTES);
      const envelope = ingressEnvelope(body);
      const { subject } = verifyRunnerGrant(body.authorization, {
        operation: op,
        datasetId,
        intentParts: [datasetId, priceDrops, String(challengeDays), String(sizeBytes), envelope.ciphertext],
      });
      const result = await sealDatasetEnvelope(datasetId, envelope, sizeBytes);
      return {
        ...result,
        runnerReceipt: issueDatasetReceipt(subject, {
          datasetId,
          cid: result.cid,
          wrappedKey: result.wrappedKey,
          merkleRoot: result.merkleRoot,
          priceDrops,
          challengeDays,
        }),
      };
    }
    case "run-loan-job": {
      const dataset = datasetRef(body);
      const loanId = text(body, "loanId");
      const datasetReceiptToken = text(body, "datasetReceipt", MAX_RECEIPT_LENGTH);
      const escrowTxHash = text(body, "escrowTxHash", MAX_TX_HASH_LENGTH);
      const escrowSequence = integer(body, "escrowSequence");
      const deliveryPublicKey = text(body, "deliveryPublicKey", 200);
      const datasetReceipt = verifyDatasetReceipt(datasetReceiptToken, dataset);
      const { subject } = verifyRunnerGrant(body.authorization, {
        operation: op,
        datasetId: dataset.datasetId,
        loanId,
        intentParts: [
          loanId,
          dataset.datasetId,
          datasetReceiptToken,
          escrowTxHash,
          String(escrowSequence),
          deliveryPublicKey,
        ],
      });
      const input = { ...dataset, loanId, borrower: subject } satisfies LoanJobInput;
      await verifyEscrowCreateProof({
        txHash: escrowTxHash,
        loanId,
        borrower: subject,
        provider: datasetReceipt.owner,
        sequence: escrowSequence,
        amountDrops: datasetReceipt.priceDrops,
        challengeDays: datasetReceipt.challengeDays,
      });
      const result = await getTeeRunner().run(input);
      const releaseEnvelope = encryptRunnerRelease(
        loanModelKey(loanId, subject),
        deliveryPublicKey,
        loanDeliveryContext(loanId, subject),
        result.fulfillmentHex,
        "xrpl-fulfillment",
      );
      return {
        modelCid: result.modelCid,
        metrics: result.metrics,
        resultHash: result.resultHash,
        attestation: result.attestation,
        quote: result.quote,
        quoteEventLog: result.quoteEventLog,
        composeHash: result.composeHash,
        conditionHex: result.conditionHex,
        releaseEnvelope,
        runnerReceipt: issueLoanReceipt({
          loanId: input.loanId,
          datasetId: input.datasetId,
          borrower: subject,
          provider: datasetReceipt.owner,
          modelCid: result.modelCid,
          escrowTxHash,
          escrowSequence,
          deliveryPublicKey,
          amountDrops: datasetReceipt.priceDrops,
          challengeDays: datasetReceipt.challengeDays,
          releaseEnvelopeHash: hashRunnerReleaseEnvelope(releaseEnvelope),
          attestationHash: result.attestation.payloadHash,
        }),
      };
    }
    case "prepare-loan-delivery": {
      const loanId = text(body, "loanId");
      const loanReceiptToken = text(body, "loanReceipt", MAX_RECEIPT_LENGTH);
      const deliveryPublicKey = text(body, "deliveryPublicKey", 200);
      const receipt = verifyLoanReceipt(loanReceiptToken, loanId);
      const { subject } = verifyRunnerGrant(body.authorization, {
        operation: op,
        loanId,
        intentParts: [loanId, loanReceiptToken, deliveryPublicKey],
      });
      if (subject !== receipt.borrower) throw new AppError("Livraison réservée au borrower", 403);
      const releaseEnvelope = encryptRunnerRelease(
        loanModelKey(loanId, receipt.borrower),
        deliveryPublicKey,
        loanDeliveryContext(loanId, receipt.borrower),
        escrowRelease(loanId, receipt.borrower).fulfillmentHex,
        "xrpl-fulfillment",
      );
      return {
        releaseEnvelope,
        runnerReceipt: issueLoanReceipt({
          loanId: receipt.loanId,
          datasetId: receipt.datasetId,
          borrower: receipt.borrower,
          provider: receipt.provider,
          modelCid: receipt.modelCid,
          escrowTxHash: receipt.escrowTxHash,
          escrowSequence: receipt.escrowSequence,
          deliveryPublicKey,
          amountDrops: receipt.amountDrops,
          challengeDays: receipt.challengeDays,
          releaseEnvelopeHash: hashRunnerReleaseEnvelope(releaseEnvelope),
          attestationHash: receipt.attestationHash,
        }),
      };
    }
    case "settle-loan": {
      const loanId = text(body, "loanId");
      const loanReceiptToken = text(body, "loanReceipt", MAX_RECEIPT_LENGTH);
      const releaseEnvelopeHash = text(body, "releaseEnvelopeHash", 64);
      const receipt = verifyLoanReceipt(loanReceiptToken, loanId);
      assertLoanReleaseEnvelopeHash(receipt, releaseEnvelopeHash);
      const { subject } = verifyRunnerGrant(body.authorization, {
        operation: op,
        loanId,
        intentParts: [loanId, loanReceiptToken, releaseEnvelopeHash],
      });
      if (subject !== receipt.borrower) throw new AppError("Règlement réservé au borrower", 403);
      try {
        await verifyEscrowCreateProof({
          txHash: receipt.escrowTxHash,
          loanId,
          borrower: receipt.borrower,
          provider: receipt.provider,
          sequence: receipt.escrowSequence,
          amountDrops: receipt.amountDrops,
          challengeDays: receipt.challengeDays,
        });
      } catch (error) {
        if (!(error instanceof AppError) || error.status !== 409) throw error;
      }
      const settleTxHash = await settleEscrowInRunner(receipt);
      const auditTxHash = await recordAuditReceipt(receipt).catch((error) => {
        console.error("[runner] reçu d’audit on-chain échoué (best-effort)", error);
        return null;
      });
      return { settleTxHash, auditTxHash };
    }
    case "reconcile-loan-escrow": {
      const loanId = text(body, "loanId");
      const borrower = text(body, "borrower");
      const escrowTxHash = text(body, "escrowTxHash", MAX_TX_HASH_LENGTH);
      const escrowSequence = integer(body, "escrowSequence");
      const loanReceiptToken = body.loanReceipt;
      if (loanReceiptToken !== undefined && typeof loanReceiptToken !== "string") {
        throw new AppError("loanReceipt invalide", 400);
      }
      const receipt = loanReceiptToken
        ? verifyLoanReceipt(text(body, "loanReceipt", MAX_RECEIPT_LENGTH), loanId)
        : undefined;
      return reconcileLoanEscrowInRunner({
        loanId,
        borrower,
        escrowTxHash,
        escrowSequence,
        receipt,
      });
    }
    case "run-training": {
      const dataset = datasetRef(body);
      const jobId = text(body, "jobId");
      const datasetReceiptToken = text(body, "datasetReceipt", MAX_RECEIPT_LENGTH);
      const datasetReceipt = verifyDatasetReceipt(datasetReceiptToken, dataset);
      const { subject } = verifyRunnerGrant(body.authorization, {
        operation: op,
        datasetId: dataset.datasetId,
        jobId,
        intentParts: [dataset.datasetId, jobId, datasetReceiptToken],
      });
      if (subject !== datasetReceipt.owner) throw new AppError("Self-train réservé au propriétaire", 403);
      const input = { ...dataset, jobId, owner: subject } satisfies SelfTrainingInput;
      const result = await runSelfTraining(input);
      return {
        ...result,
        runnerReceipt: issueTrainingReceipt({
          jobId: input.jobId,
          datasetId: input.datasetId,
          owner: subject,
          modelCid: result.modelCid,
        }),
      };
    }
    case "loan-model-key": {
      const loanId = text(body, "loanId");
      const loanReceiptToken = text(body, "loanReceipt", MAX_RECEIPT_LENGTH);
      const settleTxHash = text(body, "settleTxHash", MAX_TX_HASH_LENGTH);
      const deliveryPublicKey = text(body, "deliveryPublicKey", 200);
      const receipt = verifyLoanReceipt(loanReceiptToken, loanId);
      const { subject } = verifyRunnerGrant(body.authorization, {
        operation: op,
        loanId,
        intentParts: [loanId, loanReceiptToken, settleTxHash, deliveryPublicKey],
      });
      if (subject !== receipt.borrower) throw new AppError("Clé réservée au borrower", 403);
      await verifyEscrowFinishProof({
        txHash: settleTxHash,
        loanId,
        borrower: receipt.borrower,
        sequence: receipt.escrowSequence,
      });
      return {
        modelKeyEnvelope: encryptRunnerDelivery(
          loanModelKey(loanId, receipt.borrower),
          deliveryPublicKey,
          loanDeliveryContext(loanId, receipt.borrower),
        ),
      };
    }
    case "self-train-key": {
      const jobId = text(body, "jobId");
      const jobReceiptToken = text(body, "jobReceipt", MAX_RECEIPT_LENGTH);
      const deliveryPublicKey = text(body, "deliveryPublicKey", 200);
      const receipt = verifyTrainingReceipt(jobReceiptToken, jobId);
      const { subject } = verifyRunnerGrant(body.authorization, {
        operation: op,
        jobId,
        intentParts: [jobId, jobReceiptToken, deliveryPublicKey],
      });
      if (subject !== receipt.owner) throw new AppError("Clé réservée au propriétaire", 403);
      return {
        modelKeyEnvelope: encryptRunnerDelivery(
          selfTrainModelKey(jobId, receipt.owner),
          deliveryPublicKey,
          selfTrainDeliveryContext(jobId, receipt.owner),
        ),
      };
    }
    case "escrow-condition":
      return {
        conditionHex: escrowConditionPublic(text(body, "loanId"), text(body, "borrower")),
      };

    // ---------------------------------------------------------------------------
    // Rail EVM — Robinhood Chain
    // ---------------------------------------------------------------------------

    /** Cadenas public que le borrower pose lui-même via `lock()`. Le secret ne sort pas. */
    case "evm-escrow-hashlock":
      return { hashlock: escrowHashlock(text(body, "loanId"), text(body, "borrower")) };

    case "evm-run-loan-job": {
      const dataset = datasetRef(body);
      const loanId = text(body, "loanId");
      const datasetReceiptToken = text(body, "datasetReceipt", MAX_RECEIPT_LENGTH);
      const deliveryPublicKey = text(body, "deliveryPublicKey", 200);
      const datasetReceipt = verifyDatasetReceipt(datasetReceiptToken, dataset);
      const { subject } = verifyRunnerGrant(body.authorization, {
        operation: op,
        datasetId: dataset.datasetId,
        loanId,
        intentParts: [loanId, dataset.datasetId, datasetReceiptToken, deliveryPublicKey],
      });

      const borrower = canonicalSubject(subject);
      const loanKey = loanKeyFor(borrower, loanId);
      const { hashlock, preimage } = escrowLock(loanId, borrower);
      // Le prix vient du reçu SIGNÉ du dataset, jamais du corps de la requête : sinon
      // un borrower bloquerait un wei on-chain, déclarerait ce montant, et le contrôle
      // de portée passerait — le provider serait livré au prix que l'emprunteur choisit.
      const amountWei = datasetReceipt.priceWei;
      if (!amountWei) {
        throw new AppError(
          "Dataset scellé sans prix EVM — rescelle-le avant de l'emprunter sur cette chaîne",
          409,
        );
      }

      // Contrôle de portée on-chain avant tout déchiffrement. Là où le rail XRPL
      // enchaînait une lecture de transaction historique puis une lecture de l'objet
      // escrow, une seule vue suffit ici — et elle vérifie en prime qu'il reste assez
      // de temps avant expiration pour que le règlement soit finalisé.
      await assertLoanScope({
        loanKey,
        borrower,
        provider: datasetReceipt.owner,
        amountWei,
        hashlock,
      });

      const result = await runEvmLoanJob({ ...dataset, loanId, borrower });
      const payloadHash = createHash("sha256")
        .update(result.modelCid)
        .update(dataset.merkleRoot)
        .update(loanId)
        .update(borrower)
        .digest("hex");
      const attestation = attest(payloadHash);

      const releaseEnvelope = encryptRunnerRelease(
        evmLoanModelKey(loanId, borrower),
        deliveryPublicKey,
        loanDeliveryContext(loanId, borrower),
        preimage,
        "evm-preimage",
      );

      const { chainId, escrow } = evmEscrowBinding();
      return {
        modelCid: result.modelCid,
        metrics: result.metrics,
        attestation,
        loanKey,
        hashlock,
        releaseEnvelope,
        runnerReceipt: issueEvmLoanReceipt({
          loanId,
          datasetId: dataset.datasetId,
          borrower,
          provider: datasetReceipt.owner,
          modelCid: result.modelCid,
          loanKey,
          chainId,
          escrow,
          amountWei,
          challengeDays: datasetReceipt.challengeDays,
          deliveryPublicKey,
          releaseEnvelopeHash: hashRunnerReleaseEnvelope(releaseEnvelope),
          attestationHash: attestation.payloadHash,
        }),
      };
    }

    case "evm-settle-loan": {
      const loanId = text(body, "loanId");
      const loanReceiptToken = text(body, "loanReceipt", MAX_RECEIPT_LENGTH);
      const releaseEnvelopeHash = text(body, "releaseEnvelopeHash", 64);
      const receipt = verifyEvmLoanReceipt(loanReceiptToken, loanId);

      // Le hash de la capsule relue chez le borrower doit correspondre à celle que le
      // runner a scellée : c'est la preuve qu'il la détient AVANT que le paiement ne
      // publie le secret qui l'ouvre. Sans ce contrôle, le fair-exchange n'existe pas.
      assertEvmReleaseEnvelopeHash(receipt, releaseEnvelopeHash);

      const { subject } = verifyRunnerGrant(body.authorization, {
        operation: op,
        loanId,
        intentParts: [loanId, loanReceiptToken, releaseEnvelopeHash],
      });
      if (canonicalSubject(subject) !== receipt.borrower) {
        throw new AppError("Règlement réservé au borrower", 403);
      }

      const { preimage } = escrowLock(loanId, receipt.borrower);
      const settleTxHash = await settleEscrow(receipt.loanKey as `0x${string}`, preimage as `0x${string}`);
      return { settleTxHash, loanKey: receipt.loanKey };
    }

    /** Re-livraison de la clé du modèle après règlement, pour un navigateur neuf. */
    case "evm-loan-model-key": {
      const loanId = text(body, "loanId");
      const loanReceiptToken = text(body, "loanReceipt", MAX_RECEIPT_LENGTH);
      const deliveryPublicKey = text(body, "deliveryPublicKey", 200);
      const receipt = verifyEvmLoanReceipt(loanReceiptToken, loanId);
      const { subject } = verifyRunnerGrant(body.authorization, {
        operation: op,
        loanId,
        intentParts: [loanId, loanReceiptToken, deliveryPublicKey],
      });
      if (canonicalSubject(subject) !== receipt.borrower) {
        throw new AppError("Clé réservée au borrower", 403);
      }

      // La preuve du règlement est lue on-chain, pas fournie par l'appelant : l'état
      // du prêt fait autorité, et un hash de transaction ne peut donc pas être forgé.
      const resolution = await reconcileLoanEscrow(receipt.loanKey as `0x${string}`);
      if (resolution.state !== "settled") {
        throw new AppError("Modèle pas encore réglé on-chain", 409);
      }

      return {
        modelCid: receipt.modelCid,
        settleTxHash: resolution.txHash,
        modelKeyEnvelope: encryptRunnerDelivery(
          evmLoanModelKey(loanId, receipt.borrower),
          deliveryPublicKey,
          loanDeliveryContext(loanId, receipt.borrower),
        ),
      };
    }
  }
}
