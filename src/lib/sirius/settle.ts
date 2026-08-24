import "server-only";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { verifyAttestation } from "@/lib/tee/attestation";
import { verifyTdxQuote } from "@/lib/tee/quote";
import {
  prepareLoanDeliveryInRunner,
  runLoanJobInRunner,
  settleLoanInRunner,
  usesRemoteRunner,
} from "@/lib/tee/runner-client";
import type { RunnerReleaseEnvelope } from "@/lib/tee/contract";
import type { PreparedLoanJobResult } from "@/lib/tee/types";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { liveEscrow } from "@/lib/xrpl/escrow";
import { settlementFailureState } from "@/lib/sirius/settlement-policy";
import { unpinModelUnlessReferenced } from "@/lib/sirius/model-storage";

const SETTLEMENT_LEASE_MS = 90_000;
const TRAINING_LEASE_MS = 90_000;

export interface PreparedLoanResult {
  loanId: string;
  modelCid: string;
  runnerReceipt: string;
  releaseEnvelope: RunnerReleaseEnvelope;
}

export interface SettleResult {
  loanId: string;
  modelCid: string;
  runnerReceipt: string;
  settleTxHash: string;
  auditTxHash: string | null;
}

async function verifyLoanAttestation(result: PreparedLoanJobResult): Promise<void> {
  if (usesRemoteRunner()) {
    if (process.env.NODE_ENV !== "production") return;
    if (!result.quote || !result.quoteEventLog || !result.composeHash) {
      throw new AppError("Preuve TDX incomplète — préparation refusée", 400);
    }
    const verification = await verifyTdxQuote(
      result.quote,
      result.attestation.payloadHash,
      { eventLog: result.quoteEventLog, composeHash: result.composeHash },
    );
    if (
      !verification.reportDataMatches ||
      verification.hardwareVerified !== true ||
      verification.tcbStatus !== "UpToDate" ||
      verification.codeIdentityMatches !== true
    ) {
      throw new AppError("Attestation TDX invalide — préparation refusée", 400);
    }
    return;
  }
  if (!verifyAttestation(result.attestation)) {
    throw new AppError("Attestation invalide — préparation refusée", 400);
  }
}

/**
 * Phase 1 : entraîne et remet au navigateur une capsule verrouillée. Aucun paiement
 * n'est déclenché ici et le fulfillment ne quitte pas le runner.
 */
export async function prepareLoanResult(
  loanId: string,
  deliveryPublicKey: string,
  authorization: RunnerGrant,
): Promise<PreparedLoanResult> {
  const now = new Date();
  await prisma.loan.updateMany({
    where: {
      id: loanId,
      status: "TRAINING",
      modelCid: null,
      updatedAt: { lte: new Date(now.getTime() - TRAINING_LEASE_MS) },
    },
    data: { status: "ESCROWED", updatedAt: now },
  });
  const lock = await prisma.loan.updateMany({
    where: { id: loanId, status: "ESCROWED" },
    data: {
      status: "TRAINING",
      updatedAt: now,
      modelCid: null,
      attestationHash: null,
      attestationQuote: null,
      attestationEventLog: null,
      attestationComposeHash: null,
      runnerReceipt: null,
    },
  });
  if (lock.count === 0) throw new AppError("Loan non escrow ou déjà en cours", 409);

  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: { dataset: { omit: { wrappedKey: false } } },
  });
  if (!loan || loan.escrowSequence == null) {
    await prisma.loan.updateMany({
      where: { id: loanId, status: "TRAINING", updatedAt: now },
      data: { status: "ESCROWED" },
    });
    throw new AppError("Escrow sequence manquante", 409);
  }
  const { dataset } = loan;
  if (
    !dataset.ipfsCid ||
    !dataset.merkleRoot ||
    !dataset.wrappedKey ||
    !dataset.runnerReceipt ||
    !loan.escrowTxHash
  ) {
    await prisma.loan.updateMany({
      where: { id: loanId, status: "TRAINING", updatedAt: now },
      data: { status: "ESCROWED" },
    });
    throw new AppError("Dataset indisponible (non finalisé ou clé détruite)", 409);
  }

  let result: PreparedLoanJobResult | undefined;
  try {
    result = await runLoanJobInRunner(
      {
        loanId,
        datasetId: dataset.id,
        cid: dataset.ipfsCid,
        wrappedKey: dataset.wrappedKey,
        merkleRoot: dataset.merkleRoot,
        priceDrops: dataset.priceDrops,
        challengeDays: dataset.challengeDays,
      },
      {
        datasetReceipt: dataset.runnerReceipt,
        escrowTxHash: loan.escrowTxHash,
        escrowSequence: loan.escrowSequence,
        deliveryPublicKey,
      },
      authorization,
    );
    if (result.conditionHex !== loan.conditionHex) {
      throw new AppError("Condition de release incohérente", 409);
    }
    await verifyLoanAttestation(result);
    const persisted = await prisma.loan.updateMany({
      where: { id: loanId, status: "TRAINING", modelCid: null, updatedAt: now },
      data: {
        modelCid: result.modelCid,
        attestationHash: result.attestation.payloadHash,
        attestationQuote: result.quote ?? null,
        attestationEventLog: result.quoteEventLog ?? null,
        attestationComposeHash: result.composeHash ?? null,
        runnerReceipt: result.runnerReceipt,
      },
    });
    if (persisted.count !== 1) {
      throw new AppError("Le lease d’entraînement a expiré avant la persistance du résultat", 409);
    }
    return {
      loanId,
      modelCid: result.modelCid,
      runnerReceipt: result.runnerReceipt,
      releaseEnvelope: result.releaseEnvelope,
    };
  } catch (err) {
    const escrow = await liveEscrow(loan.borrower, loan.escrowSequence).catch(() => undefined);
    await prisma.loan.updateMany({
      where: { id: loanId, status: "TRAINING", modelCid: null, updatedAt: now },
      data: {
        status:
          (err instanceof AppError && err.status === 410) || escrow === null
            ? "CANCELLED"
            : "ESCROWED",
      },
    });
    if (result?.modelCid) await unpinModelUnlessReferenced(result.modelCid, dataset.id);
    throw err;
  }
}

/** Régénère une capsule pré-règlement pour un navigateur qui a perdu sa clé locale. */
export async function replaceLoanDelivery(
  loanId: string,
  deliveryPublicKey: string,
  authorization: RunnerGrant,
): Promise<PreparedLoanResult> {
  const loan = await prisma.loan.findUnique({ where: { id: loanId } });
  if (
    !loan ||
    loan.status !== "TRAINING" ||
    !loan.modelCid ||
    !loan.runnerReceipt ||
    loan.escrowSequence == null
  ) {
    throw new AppError("Résultat TEE non préparé", 409);
  }
  const previousReceipt = loan.runnerReceipt;
  const prepared = await prepareLoanDeliveryInRunner(
    loanId,
    previousReceipt,
    deliveryPublicKey,
    authorization,
  );
  const updated = await prisma.loan.updateMany({
    where: { id: loanId, status: "TRAINING", runnerReceipt: previousReceipt },
    data: { runnerReceipt: prepared.runnerReceipt },
  });
  if (updated.count !== 1) throw new AppError("Le règlement a changé pendant la préparation", 409);
  return {
    loanId,
    modelCid: loan.modelCid,
    runnerReceipt: prepared.runnerReceipt,
    releaseEnvelope: prepared.releaseEnvelope,
  };
}

/**
 * Phase 2 : après confirmation navigateur que la capsule est persistée, le runner
 * soumet lui-même EscrowFinish. Le fulfillment devient public dans cette transaction
 * et déverrouille simultanément la capsule déjà détenue par le borrower.
 */
export async function settlePreparedLoan(
  loanId: string,
  releaseEnvelopeHash: string,
  authorization: RunnerGrant,
): Promise<SettleResult> {
  const loan = await prisma.loan.findUnique({ where: { id: loanId } });
  if (!loan) throw new AppError("Loan introuvable", 404);
  if (loan.status === "SETTLED" && loan.modelCid && loan.runnerReceipt && loan.settleTxHash) {
    return {
      loanId,
      modelCid: loan.modelCid,
      runnerReceipt: loan.runnerReceipt,
      settleTxHash: loan.settleTxHash,
      auditTxHash: loan.auditTxHash,
    };
  }
  if (
    (loan.status !== "TRAINING" && loan.status !== "SETTLING") ||
    !loan.modelCid ||
    !loan.runnerReceipt ||
    !loan.attestationHash
  ) {
    throw new AppError("Résultat TEE non préparé", 409);
  }

  const now = new Date();
  if (loan.status === "TRAINING") {
    const claim = await prisma.loan.updateMany({
      where: { id: loanId, status: "TRAINING", runnerReceipt: loan.runnerReceipt },
      data: { status: "SETTLING", updatedAt: now },
    });
    if (claim.count !== 1) throw new AppError("Règlement déjà en cours", 409);
  } else {
    const claim = await prisma.loan.updateMany({
      where: {
        id: loanId,
        status: "SETTLING",
        runnerReceipt: loan.runnerReceipt,
        updatedAt: { lte: new Date(now.getTime() - SETTLEMENT_LEASE_MS) },
      },
      data: { updatedAt: now },
    });
    if (claim.count !== 1) throw new AppError("Règlement déjà en cours — réessaie dans un instant", 409);
  }

  let settlement: { settleTxHash: string; auditTxHash: string | null };
  try {
    settlement = await settleLoanInRunner(
      loanId,
      loan.runnerReceipt,
      releaseEnvelopeHash,
      authorization,
    );
  } catch (error) {
    const recoveryState = settlementFailureState(error);
    if (recoveryState) {
      await prisma.loan.updateMany({
        where: {
          id: loanId,
          status: "SETTLING",
          runnerReceipt: loan.runnerReceipt,
          updatedAt: now,
        },
        data: { status: recoveryState },
      });
    }
    throw error;
  }
  const settled = await prisma.loan.updateMany({
    where: { id: loanId, status: "SETTLING", runnerReceipt: loan.runnerReceipt },
    data: {
      status: "SETTLED",
      settleTxHash: settlement.settleTxHash,
      auditTxHash: settlement.auditTxHash,
      settledAt: new Date(),
    },
  });
  if (settled.count !== 1) throw new AppError("Règlement XRPL confirmé mais état local incohérent", 409);

  return {
    loanId,
    modelCid: loan.modelCid,
    runnerReceipt: loan.runnerReceipt,
    settleTxHash: settlement.settleTxHash,
    auditTxHash: settlement.auditTxHash,
  };
}
