import "server-only";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { reconcileLoanEscrow } from "@/lib/evm/escrow";
import { runLoanJobInRunner, settleLoanInRunner } from "@/lib/tee/runner-client";
import type { RunnerReleaseEnvelope } from "@/lib/tee/contract";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { unpinModelUnlessReferenced } from "./model-storage";

const TRAINING_LEASE_MS = 90_000;

export interface PreparedLoanResult {
  loanId: string;
  modelCid: string;
  runnerReceipt: string;
  releaseEnvelope: RunnerReleaseEnvelope;
}

export interface SettleResult extends Omit<PreparedLoanResult, "releaseEnvelope"> {
  settleTxHash: string;
}

export async function prepareLoanResult(
  loanId: string,
  deliveryPublicKey: string,
  authorization: RunnerGrant,
): Promise<PreparedLoanResult> {
  const now = new Date();
  await prisma.loan.updateMany({
    where: { id: loanId, status: "TRAINING", modelCid: null, updatedAt: { lte: new Date(now.getTime() - TRAINING_LEASE_MS) } },
    data: { status: "ESCROWED", updatedAt: now },
  });
  const claimed = await prisma.loan.updateMany({
    where: { id: loanId, status: "ESCROWED" },
    data: { status: "TRAINING", updatedAt: now, modelCid: null, runnerReceipt: null, attestationHash: null },
  });
  if (claimed.count !== 1) throw new AppError("Loan non verrouillé ou déjà en cours", 409);

  // `wrappedKey` est retirée de toute lecture par le `omit` global de `db.ts`, pour
  // qu'elle ne puisse jamais partir dans une réponse d'API. Les contrôles ci-dessous
  // vérifient qu'elle EXISTE — sur un objet d'où elle vient d'être supprimée, ils
  // échouaient donc systématiquement, et aucun dataset ne pouvait être publié,
  // emprunté ni réglé. On la réinclut ici, comme le prévoit `db.ts` : cet objet ne
  // quitte pas le serveur.
  const loan = await prisma.loan.findUnique({ where: { id: loanId }, include: { dataset: { omit: { wrappedKey: false } } } });
  if (!loan || !loan.evmLoanKey || !loan.evmLockTxHash || !loan.evmLockBlock || !loan.amountUsdcAtomic) {
    throw new AppError("Lock USDC absent", 409);
  }
  const { dataset } = loan;
  if (!dataset.ipfsCid || !dataset.merkleRoot || !dataset.wrappedKey || !dataset.runnerReceipt || !dataset.priceUsdcAtomic) {
    await prisma.loan.updateMany({ where: { id: loanId, status: "TRAINING", updatedAt: now }, data: { status: "ESCROWED" } });
    throw new AppError("Dataset EVM indisponible", 409);
  }

  let result: Awaited<ReturnType<typeof runLoanJobInRunner>> | undefined;
  try {
    result = await runLoanJobInRunner(
      {
        loanId,
        datasetId: dataset.id,
        cid: dataset.ipfsCid,
        wrappedKey: dataset.wrappedKey,
        merkleRoot: dataset.merkleRoot,
        priceUsdcAtomic: dataset.priceUsdcAtomic,
        challengeDays: dataset.challengeDays,
      },
      dataset.runnerReceipt,
      deliveryPublicKey,
      authorization,
    );
    if (!/^[a-f0-9]{64}$/i.test(result.attestation.payloadHash)) throw new AppError("Attestation runner invalide", 502);
    const persisted = await prisma.loan.updateMany({
      where: { id: loanId, status: "TRAINING", modelCid: null, updatedAt: now },
      data: { modelCid: result.modelCid, runnerReceipt: result.runnerReceipt, attestationHash: result.attestation.payloadHash },
    });
    if (persisted.count !== 1) throw new AppError("Lease d’entraînement expiré", 409);
    return { loanId, modelCid: result.modelCid, runnerReceipt: result.runnerReceipt, releaseEnvelope: result.releaseEnvelope };
  } catch (error) {
    const resolution = await reconcileLoanEscrow(loan.evmLoanKey as `0x${string}`, BigInt(loan.evmLockBlock)).catch(() => undefined);
    await prisma.loan.updateMany({
      where: { id: loanId, status: "TRAINING", modelCid: null, updatedAt: now },
      data: { status: resolution?.state === "cancelled" ? "CANCELLED" : "ESCROWED" },
    });
    if (result?.modelCid) await unpinModelUnlessReferenced(result.modelCid, dataset.id);
    throw error;
  }
}

export async function settlePreparedLoan(
  loanId: string,
  releaseEnvelopeHash: string,
  authorization: RunnerGrant,
): Promise<SettleResult> {
  const loan = await prisma.loan.findUnique({ where: { id: loanId } });
  if (!loan) throw new AppError("Loan introuvable", 404);
  if (loan.status === "SETTLED" && loan.modelCid && loan.runnerReceipt && loan.settleTxHash) {
    return { loanId, modelCid: loan.modelCid, runnerReceipt: loan.runnerReceipt, settleTxHash: loan.settleTxHash };
  }
  if (
    (loan.status !== "TRAINING" && loan.status !== "SETTLING") ||
    !loan.modelCid ||
    !loan.runnerReceipt ||
    !loan.evmLoanKey ||
    !loan.evmLockBlock
  ) {
    throw new AppError("Résultat TEE non préparé", 409);
  }
  const claimed = await prisma.loan.updateMany({
    where: { id: loanId, status: loan.status, runnerReceipt: loan.runnerReceipt },
    data: { status: "SETTLING", updatedAt: new Date() },
  });
  if (claimed.count !== 1) throw new AppError("Règlement déjà en cours", 409);

  try {
    const settlement = await settleLoanInRunner(
      loanId,
      loan.runnerReceipt,
      releaseEnvelopeHash,
      loan.evmLockBlock,
      authorization,
    );
    const updated = await prisma.loan.updateMany({
      where: { id: loanId, status: "SETTLING", runnerReceipt: loan.runnerReceipt },
      data: { status: "SETTLED", settleTxHash: settlement.settleTxHash, settledAt: new Date() },
    });
    if (updated.count !== 1) throw new AppError("Règlement USDC confirmé mais état local incohérent", 409);
    return { loanId, modelCid: loan.modelCid, runnerReceipt: loan.runnerReceipt, settleTxHash: settlement.settleTxHash };
  } catch (error) {
    const resolution = await reconcileLoanEscrow(loan.evmLoanKey as `0x${string}`, BigInt(loan.evmLockBlock)).catch(() => undefined);
    await prisma.loan.updateMany({
      where: { id: loanId, status: "SETTLING", runnerReceipt: loan.runnerReceipt },
      data:
        resolution?.state === "settled"
          ? { status: "SETTLED", settleTxHash: resolution.txHash, settledAt: new Date() }
          : resolution?.state === "cancelled"
            ? { status: "CANCELLED", cancelTxHash: resolution.txHash }
            : { status: "TRAINING" },
    });
    throw error;
  }
}
