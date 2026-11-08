import "server-only";
import type { Hex } from "viem";
import { prisma, serializableTransaction } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { addressesEqual, normalizeAddress } from "@/lib/evm/address";
import { reconcileLoanEscrow } from "@/lib/evm/escrow";
import { loanBillingQuote } from "@/lib/billing/loan";
import { modelSelection } from "@/lib/models/registry";
import { RunnerFinalityPending } from "@/lib/runner/failure-policy";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { assertCurrentRunner } from "@/lib/runner/provenance";
import { extendLoanInRunner } from "@/lib/tee/runner-client";
import { EXTENSION_PENDING, EXTENSION_SETTLEMENT_BUSY } from "@/lib/loans/settlement-status";
import { prepareLoan } from "./borrower";
import { assertExtendableLoan } from "./rental";
import { settlementQueuedError } from "./settlement-queued";
import { releaseFinalityTier } from "./release-tier";
import { recordSettlementEvidence } from "./settlement-evidence";

/**
 * Prolongation d'une location (D-29). Un prêt de prolongation (`extendsLoanId` → prêt d'origine)
 * suit le même flux de lock qu'un emprunt (préparation, approbation, lock, `submit`), avec un devis
 * de `rentalDays` jours au prix par jour et le compute sans entraînement de la politique. Une fois le
 * lock finalisé — au palier rapide sous les mêmes plafonds qu'un emprunt (release-tier.ts) —, le
 * runner (`extend-loan`) vérifie emprunteur, dataset et modèle scellé d'origine, diffuse le
 * `release` et repousse l'échéance ; Next la reporte sur le prêt d'origine.
 */

export interface LoanExtensionResult {
  loanId: string;
  originalLoanId: string;
  settleTxHash: string;
  rentalExpiresAt: string;
}

/** Prépare le lock d'une prolongation de `rentalDays` jours du prêt `originalLoanId`, par son emprunteur. */
export async function prepareLoanExtension(originalLoanId: string, borrower: string, rentalDays: number) {
  const original = await assertExtendableLoan(originalLoanId, normalizeAddress(borrower));
  const model = modelSelection(original.modelId, original.modelVersion);
  if (!model) throw new AppError("Profil d’entraînement du loan invalide", 409);
  return prepareLoan(original.datasetId, borrower, rentalDays, { originalLoanId: original.id, model });
}

/**
 * Règle une prolongation verrouillée : appel idempotent du runner, puis, dans une même transaction,
 * passage SETTLED de la prolongation et report de l'échéance sur le prêt d'origine (jamais en
 * arrière). Sans `authorization`, chemin serveur du reaper, comme le règlement d'un prêt facturé.
 */
export async function settleLoanExtension(loanId: string, authorization?: RunnerGrant): Promise<LoanExtensionResult> {
  const loan = await prisma.loan.findUnique({ where: { id: loanId } });
  if (!loan) throw new AppError("Loan introuvable", 404);
  if (!loan.extendsLoanId) throw new AppError("Ce prêt n’est pas une prolongation", 409);
  const signed = loanBillingQuote(loan);
  if (!signed || signed.quote.extendsLoanId !== loan.extendsLoanId) throw new AppError("Devis de prolongation absent", 409);
  if (loan.status === "SETTLED" && loan.settleTxHash && loan.rentalExpiresAt) {
    return { loanId, originalLoanId: loan.extendsLoanId, settleTxHash: loan.settleTxHash, rentalExpiresAt: loan.rentalExpiresAt.toISOString() };
  }
  if (loan.status !== "ESCROWED" && loan.status !== "SETTLING") throw new AppError("Prolongation non verrouillée ou déjà close", 409);
  if (!loan.evmLoanKey || !loan.evmLockTxHash || !loan.evmLockBlock) throw new AppError("Lock de paiement absent", 409);
  // Même emprunteur, même dataset, modèle d'origine pas encore supprimé : refus avant tout `release`.
  // Release déjà diffusé (SETTLING avec hash) : l'argent a bougé, la reprise termine toujours.
  const released = loan.status === "SETTLING" && Boolean(loan.settleTxHash);
  const original = await assertExtendableLoan(loan.extendsLoanId, loan.borrower, { released });
  if (original.datasetId !== loan.datasetId || !addressesEqual(original.provider, loan.provider)) {
    throw new AppError("Prolongation hors scope du prêt d’origine", 409);
  }
  await assertCurrentRunner(loan);
  // Le runner lit l'escrow sous la profondeur stable du palier : l'appeler plus tôt ne ferait qu'échouer.
  const finalityTier = await releaseFinalityTier(
    { ...loan, evmLoanKey: loan.evmLoanKey, evmLockBlock: loan.evmLockBlock, evmLockTxHash: loan.evmLockTxHash },
    EXTENSION_PENDING,
  );

  // Le marquage FAST vient de toucher la ligne (`updatedAt`) : la garde du claim part de son état actuel.
  const guard = finalityTier !== loan.finalityTier
    ? await prisma.loan.findUnique({ where: { id: loanId }, select: { status: true, updatedAt: true } })
    : loan;
  if (!guard) throw new AppError("Loan introuvable", 404);
  const claimedAt = new Date(Math.max(Date.now(), guard.updatedAt.getTime() + 1));
  const claimed = await prisma.loan.updateMany({
    where: { id: loanId, status: guard.status, updatedAt: guard.updatedAt },
    data: { status: "SETTLING", updatedAt: claimedAt },
  });
  if (claimed.count !== 1) throw new AppError(EXTENSION_SETTLEMENT_BUSY, 409);

  try {
    const result = await extendLoanInRunner({
      loanId,
      originalLoanId: original.id,
      loanReceipt: original.runnerReceipt,
      billingQuote: signed,
      lockBlock: loan.evmLockBlock,
      ...(authorization ? { authorization } : {}),
      ...(finalityTier === "FAST" ? { finalityTier } : {}),
    });
    if (!Number.isSafeInteger(result.expiresAt) || result.expiresAt <= 0) throw new AppError("Échéance de prolongation invalide", 502);
    const expiresAt = new Date(result.expiresAt);
    // API incluse (D-32) : la couverture reflétée suit la nouvelle échéance, jamais en arrière.
    const apiPaidUntil = signed.quote.apiAccessIncluded ? new Date(result.apiPaidUntil ?? result.expiresAt) : null;
    await serializableTransaction(async (tx) => {
      const settled = await tx.loan.updateMany({
        where: { id: loanId, status: "SETTLING", updatedAt: claimedAt },
        data: { status: "SETTLED", settleTxHash: result.settleTxHash, settledAt: new Date(), rentalExpiresAt: expiresAt },
      });
      if (settled.count !== 1) throw new AppError("Prolongation confirmée mais état local incohérent", 409);
      await tx.loan.updateMany({
        where: { id: original.id, OR: [{ rentalExpiresAt: null }, { rentalExpiresAt: { lt: expiresAt } }] },
        data: { rentalExpiresAt: expiresAt },
      });
      if (apiPaidUntil) {
        await tx.loan.updateMany({
          where: { id: original.id, OR: [{ apiPaidUntil: null }, { apiPaidUntil: { lt: apiPaidUntil } }] },
          data: { apiPaidUntil },
        });
      }
    });
    if (finalityTier === "FAST") await recordSettlementEvidence(loanId);
    return { loanId, originalLoanId: original.id, settleTxHash: result.settleTxHash, rentalExpiresAt: expiresAt.toISOString() };
  } catch (error) {
    if (error instanceof RunnerFinalityPending) {
      // Release diffusé, reçu pas encore finalisé : la prolongation reste en règlement avec son hash,
      // et une reprise (emprunteur ou reaper) rejoue la même opération idempotente.
      await prisma.loan.updateMany({
        where: { id: loanId, status: "SETTLING", updatedAt: claimedAt },
        data: { settleTxHash: error.transactionHash, updatedAt: new Date() },
      });
      throw error;
    }
    // Remboursée entre-temps : close. Réglée on-chain sans réponse : l'argent a bougé, la
    // prolongation reste en règlement avec le hash du release (comme une finalité en attente) et la
    // reprise termine le report d'échéance. Sinon, retour à ESCROWED en finalité complète (le
    // plafond rapide est rendu, le palier sera redécidé) : la reprise rejoue `extend-loan`, qui rend
    // la même échéance.
    const resolution = await reconcileLoanEscrow(loan.evmLoanKey as Hex, BigInt(loan.evmLockBlock), undefined, finalityTier).catch(() => undefined);
    await prisma.loan.updateMany({
      where: { id: loanId, status: "SETTLING", updatedAt: claimedAt },
      data: resolution?.state === "settled"
        ? { settleTxHash: resolution.txHash, updatedAt: new Date() }
        : resolution?.state === "cancelled"
          ? { status: "CANCELLED", cancelTxHash: resolution.txHash,
            ...(resolution.retainedFee !== undefined ? { retainedFeeUsdcAtomic: resolution.retainedFee, refundAmountUsdcAtomic: resolution.refundAmount } : {}) }
          : { status: "ESCROWED", finalityTier: "FULL" },
    });
    throw settlementQueuedError(error);
  }
}
