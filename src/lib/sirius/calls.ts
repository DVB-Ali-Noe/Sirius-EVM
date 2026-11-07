import "server-only";
import type { Hex } from "viem";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { addressesEqual, normalizeAddress } from "@/lib/evm/address";
import { reconcileLoanEscrow } from "@/lib/evm/escrow";
import { loanBillingQuote } from "@/lib/billing/loan";
import type { CallPackSize } from "@/lib/billing/api-pricing";
import { modelSelection } from "@/lib/models/registry";
import { RunnerFinalityPending } from "@/lib/runner/failure-policy";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { assertCurrentRunner } from "@/lib/runner/provenance";
import { buyCallsInRunner } from "@/lib/tee/runner-client";
import { CALLS_PENDING } from "@/lib/loans/settlement-status";
import { assertApiLoan } from "./api-keys";
import { requireRunnerOrWake } from "./availability";
import { prepareLoan } from "./borrower";
import { releaseFinalityTier } from "./release-tier";
import { recordSettlementEvidence } from "./settlement-evidence";
import { settlementQueuedError } from "./settlement-queued";

/**
 * Packs d'appels API prépayés (D-30). Un prêt de pack (`packForLoanId` → prêt d'origine, `callPack`
 * appels) suit le flux de lock d'une prolongation : devis signé par l'enclave (montant fournisseur =
 * taille × `ceil(prix par jour / apiCallsPerDay)`, compute sans entraînement, aucun frais d'échec,
 * jours du prêt d'origine repris sans en ajouter), approbation, lock, `submit`. Une fois le lock
 * finalisé — au palier rapide sous les plafonds habituels —, le runner (`buy-calls`) diffuse le
 * `release` et crédite le prêt d'origine une seule fois par pack ; le reaper reprend les packs
 * verrouillés non réglés. Les crédits n'ont pas de date propre : ils expirent avec la location.
 */

export interface CallPackResult {
  loanId: string;
  originalLoanId: string;
  settleTxHash: string;
  callPack: number;
  /** Solde de crédits du prêt d'origine renvoyé par l'enclave ; `null` sur une relecture locale. */
  credits: number | null;
}

/**
 * Prépare le lock d'un pack de `size` appels pour le prêt `originalLoanId`, par son emprunteur.
 * CVM éteinte : réveil demandé et 503 `enclave_starting` avant toute préparation (rien n'est payé).
 */
export async function prepareCallPack(originalLoanId: string, borrower: string, size: CallPackSize) {
  const original = await assertApiLoan(originalLoanId, normalizeAddress(borrower), { requireActiveRental: true });
  const model = modelSelection(original.modelId, original.modelVersion);
  if (!model || typeof original.rentalDays !== "number") throw new AppError("Profil d’entraînement du loan invalide", 409);
  await requireRunnerOrWake();
  return prepareLoan(original.datasetId, borrower, original.rentalDays, {
    originalLoanId: original.id, model, pack: { size, callsPerDay: original.callsPerDay },
  });
}

/**
 * Règle un pack verrouillé : appel idempotent du runner, puis passage SETTLED. Sans
 * `authorization`, chemin serveur du reaper. Rejouable : un pack déjà réglé rend son résultat sans
 * rappeler le runner, qui de toute façon ne crédite qu'une fois.
 */
export async function settleCallPack(packLoanId: string, authorization?: RunnerGrant): Promise<CallPackResult> {
  const loan = await prisma.loan.findUnique({ where: { id: packLoanId } });
  if (!loan) throw new AppError("Loan introuvable", 404);
  if (!loan.packForLoanId || typeof loan.callPack !== "number") throw new AppError("Ce prêt n’est pas un pack d’appels", 409);
  const signed = loanBillingQuote(loan);
  if (!signed || signed.quote.packForLoanId !== loan.packForLoanId || signed.quote.callPack !== loan.callPack) {
    throw new AppError("Devis de pack d’appels absent", 409);
  }
  if (loan.status === "SETTLED" && loan.settleTxHash) {
    return { loanId: loan.id, originalLoanId: loan.packForLoanId, settleTxHash: loan.settleTxHash, callPack: loan.callPack, credits: null };
  }
  if (loan.status !== "ESCROWED" && loan.status !== "SETTLING") throw new AppError("Pack d’appels non verrouillé ou déjà clos", 409);
  if (!loan.evmLoanKey || !loan.evmLockTxHash || !loan.evmLockBlock) throw new AppError("Lock de paiement absent", 409);
  // Même emprunteur, même dataset, location d'origine en cours et profil avec API : refus avant tout `release`.
  const original = await assertApiLoan(loan.packForLoanId, loan.borrower, { requireActiveRental: true });
  if (original.datasetId !== loan.datasetId || !addressesEqual(original.provider, loan.provider)) {
    throw new AppError("Pack d’appels hors scope du prêt d’origine", 409);
  }
  await assertCurrentRunner(loan);
  const finalityTier = await releaseFinalityTier(
    { ...loan, evmLoanKey: loan.evmLoanKey, evmLockBlock: loan.evmLockBlock, evmLockTxHash: loan.evmLockTxHash },
    CALLS_PENDING,
  );

  // Le marquage FAST vient de toucher la ligne (`updatedAt`) : la garde du claim part de son état actuel.
  const guard = finalityTier !== loan.finalityTier
    ? await prisma.loan.findUnique({ where: { id: packLoanId }, select: { status: true, updatedAt: true } })
    : loan;
  if (!guard) throw new AppError("Loan introuvable", 404);
  const claimedAt = new Date(Math.max(Date.now(), guard.updatedAt.getTime() + 1));
  const claimed = await prisma.loan.updateMany({
    where: { id: packLoanId, status: guard.status, updatedAt: guard.updatedAt },
    data: { status: "SETTLING", updatedAt: claimedAt },
  });
  if (claimed.count !== 1) throw new AppError("Achat d’appels déjà en cours", 409);

  try {
    const result = await buyCallsInRunner({
      loanId: packLoanId,
      originalLoanId: original.id,
      loanReceipt: original.runnerReceipt,
      billingQuote: signed,
      lockBlock: loan.evmLockBlock,
      ...(authorization ? { authorization } : {}),
      ...(finalityTier === "FAST" ? { finalityTier } : {}),
    });
    // Solde courant : un rejeu après consommation peut renvoyer moins que la taille du pack.
    if (!Number.isSafeInteger(result.credits) || result.credits < 0) throw new AppError("Crédits d’appels invalides", 502);
    const settled = await prisma.loan.updateMany({
      where: { id: packLoanId, status: "SETTLING", updatedAt: claimedAt },
      data: { status: "SETTLED", settleTxHash: result.settleTxHash, settledAt: new Date() },
    });
    if (settled.count !== 1) throw new AppError("Pack d’appels confirmé mais état local incohérent", 409);
    if (finalityTier === "FAST") await recordSettlementEvidence(packLoanId);
    return { loanId: packLoanId, originalLoanId: original.id, settleTxHash: result.settleTxHash, callPack: loan.callPack, credits: result.credits };
  } catch (error) {
    if (error instanceof RunnerFinalityPending) {
      // Release diffusé, reçu pas encore finalisé : le pack reste en règlement avec son hash, et une
      // reprise (emprunteur ou reaper) rejoue la même opération idempotente.
      await prisma.loan.updateMany({
        where: { id: packLoanId, status: "SETTLING", updatedAt: claimedAt },
        data: { settleTxHash: error.transactionHash, updatedAt: new Date() },
      });
      throw error;
    }
    // Remboursé entre-temps : clos. Sinon (y compris réglé on-chain sans réponse), retour à
    // ESCROWED : la reprise rejoue `buy-calls`, qui ne crédite pas deux fois.
    const resolution = await reconcileLoanEscrow(loan.evmLoanKey as Hex, BigInt(loan.evmLockBlock)).catch(() => undefined);
    await prisma.loan.updateMany({
      where: { id: packLoanId, status: "SETTLING", updatedAt: claimedAt },
      data: resolution?.state === "cancelled"
        ? { status: "CANCELLED", cancelTxHash: resolution.txHash,
          ...(resolution.retainedFee !== undefined ? { retainedFeeUsdcAtomic: resolution.retainedFee, refundAmountUsdcAtomic: resolution.refundAmount } : {}) }
        : { status: "ESCROWED" },
    });
    throw settlementQueuedError(error);
  }
}
