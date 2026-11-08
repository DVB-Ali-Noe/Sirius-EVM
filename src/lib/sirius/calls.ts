import "server-only";
import type { Hex } from "viem";
import type { Loan } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { addressesEqual, normalizeAddress } from "@/lib/evm/address";
import { reconcileLoanEscrow } from "@/lib/evm/escrow";
import { loanBillingQuote } from "@/lib/billing/loan";
import {
  API_ACCESS_ALREADY_PAID, API_ACCESS_NOT_FOR_SALE, API_ACCESS_NOT_FOR_SALE_CODE, API_ACCESS_STALE, API_ACCESS_STALE_CODE,
  apiAccessDaysFor, type CallPackSize,
} from "@/lib/billing/api-pricing";
import { modelSelection } from "@/lib/models/registry";
import { RunnerFinalityPending } from "@/lib/runner/failure-policy";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { assertCurrentRunner } from "@/lib/runner/provenance";
import { buyCallsInRunner } from "@/lib/tee/runner-client";
import { API_ACCESS_PENDING, CALLS_PENDING, PACK_SETTLEMENT_BUSY } from "@/lib/loans/settlement-status";
import { assertApiLoan } from "./api-keys";
import { assertNoApiAccessPassInFlight, prepareLoan } from "./borrower";
import { releaseFinalityTier } from "./release-tier";
import { recordSettlementEvidence } from "./settlement-evidence";
import { loanRentalExpiry, RENTAL_EXPIRED } from "./rental";
import { settlementQueuedError } from "./settlement-queued";

/**
 * Achats rattachés à un prêt loué (`packForLoanId` → prêt d'origine) : packs d'appels API prépayés
 * (D-30, `callPack` appels) et passes d'accès API payés au jour (D-32, `apiAccessDays` jours). Ils
 * suivent le flux de lock d'une prolongation : devis signé par l'enclave, compute sans entraînement,
 * aucun frais d'échec, jours du prêt d'origine repris sans en ajouter, approbation, lock, `submit`.
 * Pack : montant fournisseur = taille × `ceil(prix par jour / apiCallsPerDay)`. Pass : montant
 * fournisseur = minimum du contrat (0,001 USDC), Sirius jours × tarif journalier, jours comptés
 * par l'enclave jusqu'à l'échéance. Une fois le lock finalisé — au palier rapide sous les plafonds
 * habituels —, le runner (`buy-calls`) diffuse le `release` puis crédite les appels ou enregistre
 * le pass une seule fois ; le reaper reprend les achats verrouillés non réglés. Les crédits n'ont
 * pas de date propre : utilisables pendant la location, ils reviennent avec une prolongation
 * pendant la grâce et sont perdus avec le modèle. Un pass couvre jusqu'à une date
 * (`Loan.apiPaidUntil`, reflet de l'enclave) : après une prolongation, un pass complémentaire.
 */

export interface LoanPackResult {
  loanId: string;
  originalLoanId: string;
  settleTxHash: string;
  callPack: number | null;
  apiAccessDays: number | null;
  /** Solde de crédits du prêt d'origine renvoyé par l'enclave (pack) ; `null` sinon ou sur une relecture locale. */
  credits: number | null;
  /** Fin de l'accès API payé du prêt d'origine (pass, ISO) ; `null` pour un pack. */
  apiPaidUntil: string | null;
}

/**
 * Prépare le lock d'un pack de `size` appels pour le prêt `originalLoanId`, par son emprunteur.
 * CVM éteinte : réveil demandé et 503 `enclave_starting` par `prepareLoan`, avant toute préparation (rien n'est payé).
 */
export async function prepareCallPack(originalLoanId: string, borrower: string, size: CallPackSize) {
  const original = await assertApiLoan(originalLoanId, normalizeAddress(borrower), { requireActiveRental: true });
  const model = modelSelection(original.modelId, original.modelVersion);
  if (!model || typeof original.rentalDays !== "number") throw new AppError("Profil d’entraînement du loan invalide", 409);
  return prepareLoan(original.datasetId, borrower, original.rentalDays, {
    originalLoanId: original.id, model, pack: { size, callsPerDay: original.callsPerDay },
  });
}

/**
 * Prépare le lock d'un pass d'accès API (D-32) couvrant la location `originalLoanId` jusqu'à son
 * échéance, par son emprunteur. Refus avant tout paiement : tarif sans accès API (409
 * `api_access_not_for_sale`), location déjà couverte, pass déjà en paiement ou en préparation
 * (contrôle repris dans la transaction de création, `prepareLoan`). Les jours affichés ici sont une
 * estimation : ceux du devis sont comptés et signés par l'enclave avec la base de leur prix.
 */
export async function prepareApiAccessPass(originalLoanId: string, borrower: string, now = Date.now()) {
  const original = await assertApiLoan(originalLoanId, normalizeAddress(borrower), { requireActiveRental: true, now });
  const model = modelSelection(original.modelId, original.modelVersion);
  if (!model || typeof original.rentalDays !== "number") throw new AppError("Profil d’entraînement du loan invalide", 409);
  if (original.apiAccessDailyFee === null) throw new AppError(API_ACCESS_NOT_FOR_SALE, 409, API_ACCESS_NOT_FOR_SALE_CODE);
  const days = apiAccessDaysFor(original.rentalExpiresAt.getTime(), original.apiPaidUntil?.getTime() ?? null, now);
  if (days < 1) throw new AppError(API_ACCESS_ALREADY_PAID, 409, "api_access_already_paid");
  await assertNoApiAccessPassInFlight(prisma, original.id, now);
  return prepareLoan(original.datasetId, borrower, original.rentalDays, { originalLoanId: original.id, model, apiAccess: { days } });
}

/**
 * Règle un pack ou un pass verrouillé : appel idempotent du runner, puis passage SETTLED ; pour un
 * pass, dans la même transaction, `apiPaidUntil` du prêt d'origine reprend la couverture renvoyée
 * par l'enclave (jamais en arrière). Sans `authorization`, chemin serveur du reaper. Rejouable :
 * un achat déjà réglé rend son résultat sans rappeler le runner, qui de toute façon ne crédite
 * qu'une fois.
 */
export async function settleLoanPack(packLoanId: string, authorization?: RunnerGrant): Promise<LoanPackResult> {
  const loan = await prisma.loan.findUnique({ where: { id: packLoanId } });
  if (!loan) throw new AppError("Loan introuvable", 404);
  const pass = typeof loan.apiAccessDays === "number";
  if (!loan.packForLoanId || (typeof loan.callPack === "number") === pass) throw new AppError("Ce prêt n’est pas un pack d’appels", 409);
  const signed = loanBillingQuote(loan);
  if (!signed || signed.quote.packForLoanId !== loan.packForLoanId || (signed.quote.callPack ?? null) !== loan.callPack
    || (signed.quote.apiAccessDays ?? null) !== loan.apiAccessDays) {
    throw new AppError("Devis de pack d’appels absent", 409);
  }
  const view = { loanId: loan.id, originalLoanId: loan.packForLoanId, callPack: loan.callPack, apiAccessDays: loan.apiAccessDays };
  // Pass refusé pour toujours par l'enclave : jamais rejoué, remboursable à l'échéance de l'escrow.
  if (loan.apiAccessRefusedAt) throw new AppError(API_ACCESS_STALE, 409, API_ACCESS_STALE_CODE);
  if (loan.status === "SETTLED" && loan.settleTxHash) {
    const origin = pass ? await prisma.loan.findUnique({ where: { id: loan.packForLoanId }, select: { apiPaidUntil: true } }) : null;
    return { ...view, settleTxHash: loan.settleTxHash, credits: null, apiPaidUntil: origin?.apiPaidUntil?.toISOString() ?? null };
  }
  if (loan.status !== "ESCROWED" && loan.status !== "SETTLING") throw new AppError("Pack d’appels non verrouillé ou déjà clos", 409);
  if (!loan.evmLoanKey || !loan.evmLockTxHash || !loan.evmLockBlock) throw new AppError("Lock de paiement absent", 409);
  const original = await packOriginalLoan(loan, loan.packForLoanId, Boolean(authorization));
  if (original.datasetId !== loan.datasetId || !addressesEqual(original.provider, loan.provider)) {
    throw new AppError("Pack d’appels hors scope du prêt d’origine", 409);
  }
  await assertCurrentRunner(loan);
  const finalityTier = await releaseFinalityTier(
    { ...loan, evmLoanKey: loan.evmLoanKey, evmLockBlock: loan.evmLockBlock, evmLockTxHash: loan.evmLockTxHash },
    pass ? API_ACCESS_PENDING : CALLS_PENDING,
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
  if (claimed.count !== 1) throw new AppError(PACK_SETTLEMENT_BUSY, 409);

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
    const credits = pass ? null : result.credits ?? null;
    if (!pass && (credits === null || !Number.isSafeInteger(credits) || credits < 0)) throw new AppError("Crédits d’appels invalides", 502);
    const paidUntil = pass ? result.apiPaidUntil : undefined;
    if (pass && (!Number.isSafeInteger(paidUntil) || paidUntil! <= 0)) throw new AppError("Couverture d’accès API invalide", 502);
    const apiPaidUntil = paidUntil === undefined ? null : new Date(paidUntil);
    await prisma.$transaction(async (tx) => {
      const settled = await tx.loan.updateMany({
        where: { id: packLoanId, status: "SETTLING", updatedAt: claimedAt },
        data: { status: "SETTLED", settleTxHash: result.settleTxHash, settledAt: new Date() },
      });
      if (settled.count !== 1) throw new AppError("Pack d’appels confirmé mais état local incohérent", 409);
      if (apiPaidUntil) {
        await tx.loan.updateMany({
          where: { id: original.id, OR: [{ apiPaidUntil: null }, { apiPaidUntil: { lt: apiPaidUntil } }] },
          data: { apiPaidUntil },
        });
      }
    });
    if (finalityTier === "FAST") await recordSettlementEvidence(packLoanId);
    return { ...view, originalLoanId: original.id, settleTxHash: result.settleTxHash, credits, apiPaidUntil: apiPaidUntil?.toISOString() ?? null };
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
    // Remboursé entre-temps : clos. Pass caduc pour l'enclave : marqué refusé, plus jamais rejoué.
    // Sinon (y compris réglé on-chain sans réponse), retour à ESCROWED : la reprise rejoue
    // `buy-calls`, qui ne crédite pas deux fois.
    const resolution = await reconcileLoanEscrow(loan.evmLoanKey as Hex, BigInt(loan.evmLockBlock)).catch(() => undefined);
    const stale = pass && error instanceof AppError && error.code === API_ACCESS_STALE_CODE;
    await prisma.loan.updateMany({
      where: { id: packLoanId, status: "SETTLING", updatedAt: claimedAt },
      data: resolution?.state === "cancelled"
        ? { status: "CANCELLED", cancelTxHash: resolution.txHash,
          ...(resolution.retainedFee !== undefined ? { retainedFeeUsdcAtomic: resolution.retainedFee, refundAmountUsdcAtomic: resolution.refundAmount } : {}) }
        : { status: "ESCROWED", ...(stale ? { apiAccessRefusedAt: new Date() } : {}) },
    });
    throw settlementQueuedError(error);
  }
}

/**
 * Prêt d'origine d'un pack, contrôlé avant `buy-calls`. Toujours : même emprunteur, prêt ordinaire
 * réglé. Release déjà diffusé (SETTLING avec hash) : rien d'autre, l'argent a bougé et le runner
 * termine toujours ce qu'il a commencé (`beforeFirstRelease`), même location échue depuis.
 * Reaper (sans grant) : la location doit être en cours, mais le profil n'est pas relu ici — la
 * politique de facturation n'existe pas forcément dans l'environnement du reaper, et le runner, qui
 * applique la sienne, refuse avant tout `release`. Emprunteur : contrôles complets (`assertApiLoan`).
 */
async function packOriginalLoan(pack: Loan, originalLoanId: string, signed: boolean) {
  const released = pack.status === "SETTLING" && Boolean(pack.settleTxHash);
  if (signed && !released) return assertApiLoan(originalLoanId, pack.borrower, { requireActiveRental: true });
  const original = await prisma.loan.findUnique({ where: { id: originalLoanId } });
  if (!original) throw new AppError("Loan introuvable", 404);
  if (!addressesEqual(original.borrower, pack.borrower)) throw new AppError("Accès refusé : emprunt d’un autre compte", 403);
  if (original.extendsLoanId || original.packForLoanId) throw new AppError("Prolongation ou pack d’appels : utilise le prêt d’origine", 409);
  if (original.status !== "SETTLED" || !original.runnerReceipt || !original.settleTxHash) throw new AppError("Règlement du prêt non confirmé", 409);
  if (!released) {
    if (original.finalityReview) throw new AppError("Règlement du prêt non confirmé", 409);
    const expiresAt = await loanRentalExpiry(original);
    if (!expiresAt) throw new AppError("Prêt sans durée de location : API indisponible", 409);
    if (Date.now() >= expiresAt.getTime()) throw new AppError(RENTAL_EXPIRED, 403, "rental_expired");
  }
  return { ...original, runnerReceipt: original.runnerReceipt };
}
