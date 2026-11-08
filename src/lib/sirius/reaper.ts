import "server-only";
import type { Loan } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { readLoan, reconcileLoanEscrow } from "@/lib/evm/escrow";
import { getPublicClient } from "@/lib/evm/client";
import {
  CANCELLED_LOCK_SEARCH_WINDOW_MS,
  CHAIN_REAPER_LEASE_MS,
  FAST_IDLE_REVERT_MS,
  FAST_SETTLEMENT_VERIFY_DELAY_MS,
  PENDING_REAPER_TTL_MS,
  SETTLEMENT_REAPER_LEASE_MS,
  SUBMISSION_REAPER_LEASE_MS,
  TRAINING_REAPER_LEASE_MS,
} from "./reaper-policy";
import { recoverUnsubmittedLoan } from "./recover-loan";
import { resolveLoanEscrow } from "@/lib/evm/history";
import { recoverLoanResult, settlePreparedLoan } from "./settle";
import { verifyFastSettlement } from "./fast-settlement-review";
import { AppError } from "@/lib/app-error";
import { isServedModelFingerprint } from "@/lib/models/registry";
import { settleLoanExtension } from "./extend";
import { settleLoanPack } from "./calls";
import { loanRentalExpiry, RENTAL_EXPIRED, RENTAL_MODEL_DELETED } from "./rental";
import { API_ACCESS_PENDING, CALLS_PENDING, EXTENSION_PENDING } from "@/lib/loans/settlement-status";
import { API_ACCESS_STALE_CODE } from "@/lib/billing/api-pricing";
import { reaperErrorKind } from "./reaper-errors";
import { effectiveLoanFinalityTier } from "./finality-tier";

const BATCH_SIZE = 50;
let timer: ReturnType<typeof setInterval> | null = null;
let afterId: string | null = null;
let running: Promise<ReaperPassResult> | null = null;

/** Bilan d'une passe : prêts examinés et prêts restés en erreur (hors attente de finalité). */
export type ReaperPassResult = { examined: number; failed: number };

export function startLoanReaper(): void {
  if (timer) return;
  const interval = Number(process.env.SIRIUS_REAPER_INTERVAL_MS ?? 30_000);
  if (!Number.isSafeInteger(interval) || interval < 5_000 || interval > 300_000) {
    throw new Error("SIRIUS_REAPER_INTERVAL_MS invalide");
  }
  const run = () => { void runLoanReaper().catch(() => console.error("[reaper] passe indisponible, reprise à la suivante")); };
  timer = setInterval(run, interval);
  timer.unref?.();
  run();
}

export function runLoanReaper(now = new Date()): Promise<ReaperPassResult> {
  if (!running) running = reapBatch(now).finally(() => { running = null; });
  return running;
}

async function reapBatch(now: Date): Promise<ReaperPassResult> {
  const loans = await prisma.loan.findMany({
    where: {
      ...(afterId ? { id: { gt: afterId } } : {}),
      OR: [
        { status: "PENDING", createdAt: { lte: new Date(now.getTime() - PENDING_REAPER_TTL_MS) } },
        { status: "SUBMITTING", updatedAt: { lte: new Date(now.getTime() - SUBMISSION_REAPER_LEASE_MS) } },
        // Un lock soumis (hash connu) reste toujours suivi ; une préparation jamais signée sort
        // de la liste une fois son autorisation expirée et la finalité largement dépassée.
        {
          status: "CANCELLED", cancelTxHash: null, evmLoanKey: { not: null },
          OR: [
            { evmLockTxHash: { not: null } },
            { createdAt: { gt: new Date(now.getTime() - CANCELLED_LOCK_SEARCH_WINDOW_MS) } },
          ],
        },
        { status: "TRAINING", modelCid: null, updatedAt: { lte: new Date(now.getTime() - TRAINING_REAPER_LEASE_MS) } },
        { status: "SETTLING", updatedAt: { lte: new Date(now.getTime() - SETTLEMENT_REAPER_LEASE_MS) } },
        { status: { in: ["ESCROWED", "TRAINING", "SETTLING"] }, updatedAt: { lte: new Date(now.getTime() - CHAIN_REAPER_LEASE_MS) } },
        // Release accepté au palier rapide : revérifié sous le bloc finalisé, une fois celui-ci
        // censé l'avoir dépassé, jusqu'à confirmation ou ouverture d'une revue.
        {
          status: "SETTLED", finalityTier: "FAST", finalityVerifiedAt: null, finalityReview: null,
          settledAt: { lte: new Date(now.getTime() - FAST_SETTLEMENT_VERIFY_DELAY_MS) },
        },
        // Prêt rapide rendu à ESCROWED et laissé sans lancement : il n'occupe pas le plafond indéfiniment.
        { status: "ESCROWED", finalityTier: "FAST", updatedAt: { lte: new Date(now.getTime() - FAST_IDLE_REVERT_MS) } },
        // Location réglée sans échéance enregistrée (règlement réconcilié sans réponse du runner) :
        // l'échéance est relue du bloc de `release` (D-29).
        { status: "SETTLED", rentalDays: { not: null }, rentalExpiresAt: null, extendsLoanId: null, packForLoanId: null, settleTxHash: { not: null } },
      ],
    },
    orderBy: { id: "asc" },
    take: BATCH_SIZE,
  });
  // Le curseur avance aussi quand un prêt est actif ou son RPC échoue.
  afterId = loans.length === BATCH_SIZE ? loans.at(-1)!.id : null;
  let failed = 0;
  for (const loan of loans) {
    try {
      if (loan.status === "PENDING" || loan.status === "SUBMITTING" || loan.status === "CANCELLED") {
        await recoverUnsubmittedLoan(loan);
        continue;
      }
      if (loan.status === "SETTLED") {
        // Prolongations et packs réglés n'ont pas d'échéance propre ; tous passent par la revue
        // d'un release rapide (palier FAST sous les mêmes plafonds qu'un emprunt).
        if (typeof loan.rentalDays === "number" && !loan.rentalExpiresAt && !loan.extendsLoanId && !loan.packForLoanId) await loanRentalExpiry(loan);
        if (needsFastReview(loan, now)) await reviewFastSettledLoan(loan, now);
        continue;
      }
      if (loan.status === "ESCROWED" && loan.finalityTier === "FAST" && loan.updatedAt.getTime() <= now.getTime() - FAST_IDLE_REVERT_MS) {
        // Classé rapide puis laissé sans activité (prêt, prolongation, pack ou pass) : il libère le
        // plafond et repassera par la décision au prochain lancement ou règlement (finality-tier.ts).
        // Le reste de la passe le reprendra.
        const reverted = await prisma.loan.updateMany({
          where: { id: loan.id, status: "ESCROWED", finalityTier: "FAST", updatedAt: loan.updatedAt },
          data: { finalityTier: "FULL" },
        });
        if (reverted.count === 1) console.log(`[reaper] prêt EVM ${loan.id} : palier rapide rendu après inactivité`);
        continue;
      }
      if (loan.extendsLoanId) {
        await reapLoanExtension(loan, now);
        continue;
      }
      if (loan.packForLoanId) {
        await reapCallPack(loan, now);
        continue;
      }
      const chain = loan.billingQuoteHash ? await reconcileClosedLoan(loan) : null;
      if (chain === "closed") continue;
      if (!loan.modelCid && loan.billingQuoteHash) {
        if (await recoverLoanResult(loan.id)) {
          await settlePreparedLoan(loan.id);
          continue;
        }
      } else if (loan.status === "TRAINING" && !loan.modelCid) {
        await prisma.loan.updateMany({ where: { id: loan.id, status: "TRAINING", updatedAt: loan.updatedAt }, data: { status: "ESCROWED" } });
        continue;
      }
      if ((loan.status === "TRAINING" || loan.status === "SETTLING") && loan.modelCid && loan.billingQuoteHash) {
        // Entraîné avant la suppression de la livraison : aucun modèle scellé, le règlement est refusé
        // pour ne pas payer le fournisseur sans prédiction possible. L'emprunteur rembourse à l'échéance.
        if (!loan.settleTxHash && !isServedModelFingerprint(loan.modelCid)) continue;
        // Échu et toujours verrouillé on-chain, sans release diffusé : le contrat refuse désormais
        // tout release (`ChallengePeriodElapsed`), seul `refund()` par l'emprunteur libère les fonds
        // (audit A-05, A-10). Retenter le règlement toutes les 90 s ne ferait qu'osciller
        // SETTLING/TRAINING. Un release déjà diffusé (`settleTxHash`) ou un prêt réglé on-chain
        // passent encore par `settlePreparedLoan`, qui reconcilie le hash existant.
        if (chain === "active" && !loan.settleTxHash && loan.evmDeadline && loan.evmDeadline.getTime() <= now.getTime()) {
          console.log(`[reaper] prêt EVM ${loan.id} échu : règlement impossible, remboursement à l'initiative de l'emprunteur`);
          continue;
        }
        await settlePreparedLoan(loan.id);
        continue;
      }
      if (!loan.billingQuoteHash) await reconcileClosedLoan(loan);
    } catch (error) {
      const kind = reaperErrorKind(error);
      if (kind === "pending") console.log(`[reaper] prêt EVM ${loan.id} : règlement en attente de finalité`);
      else if (kind === "busy") console.log(`[reaper] prêt EVM ${loan.id} : runner occupé par un autre règlement, reprise à la passe suivante`);
      else {
        failed += 1;
        console.error(`[reaper] prêt EVM ${loan.id} non réconcilié`);
      }
    }
  }
  return { examined: loans.length, failed };
}


function needsFastReview(loan: Loan, now: Date): boolean {
  return loan.finalityTier === "FAST" && !loan.finalityVerifiedAt && !loan.finalityReview && loan.settledAt !== null
    && loan.settledAt.getTime() <= now.getTime() - FAST_SETTLEMENT_VERIFY_DELAY_MS;
}

/**
 * Prolongation verrouillée non réglée (D-29) : reprise de `extend-loan`, idempotent dans le runner,
 * comme le règlement d'un prêt ordinaire. Remboursée on-chain : close. Échue sans `release` diffusé :
 * seul `refund()` par l'emprunteur reste possible. Location d'origine close (modèle supprimé) :
 * aucune reprise, le runner refuserait avant tout `release`.
 */
async function reapLoanExtension(loan: Loan, now: Date): Promise<void> {
  const chain = await reconcileClosedLoan(loan);
  if (chain === "closed" || chain === "unbound") return;
  if (chain === "active" && !loan.settleTxHash && loan.evmDeadline && loan.evmDeadline.getTime() <= now.getTime()) {
    console.log(`[reaper] prolongation EVM ${loan.id} échue : release impossible, remboursement à l'initiative de l'emprunteur`);
    if (loan.finalityTier === "FAST") await releaseFastTier(loan.id);
    return;
  }
  try {
    await settleLoanExtension(loan.id);
  } catch (error) {
    if (error instanceof AppError && error.message === RENTAL_MODEL_DELETED) {
      console.log(`[reaper] prolongation EVM ${loan.id} : location d'origine close, remboursement à l'échéance`);
      await releaseFastTier(loan.id);
      return;
    }
    if (error instanceof AppError && error.message === EXTENSION_PENDING) return;
    throw error;
  }
}

/**
 * Pack d'appels (D-30) ou pass d'accès API (D-32) verrouillé non réglé : reprise de `buy-calls`,
 * idempotent dans le runner (crédité ou enregistré une seule fois). Remboursé on-chain : clos.
 * Échu sans `release` diffusé : seul `refund()` par l'emprunteur reste possible. Avant tout
 * `release`, location d'origine échue ou profil sans API : aucune reprise (le runner refuserait),
 * et un palier rapide est rendu au plafond. Pass caduc (`apiAccessRefusedAt`, base du prix
 * changée) : refus définitif, plus jamais rejoué, même après une prolongation. `release` déjà
 * diffusé (SETTLING avec hash) : toujours rejoué jusqu'au règlement, sans contrôle de location ni
 * de profil côté Next (`settleLoanPack`).
 */
async function reapCallPack(loan: Loan, now: Date): Promise<void> {
  const chain = await reconcileClosedLoan(loan);
  if (chain === "closed" || chain === "unbound") return;
  if (loan.apiAccessRefusedAt) {
    if (loan.finalityTier === "FAST") await releaseFastTier(loan.id);
    return;
  }
  if (chain === "active" && !loan.settleTxHash && loan.evmDeadline && loan.evmDeadline.getTime() <= now.getTime()) {
    console.log(`[reaper] pack d'appels EVM ${loan.id} échu : release impossible, remboursement à l'initiative de l'emprunteur`);
    if (loan.finalityTier === "FAST") await releaseFastTier(loan.id);
    return;
  }
  try {
    await settleLoanPack(loan.id);
  } catch (error) {
    const released = loan.status === "SETTLING" && Boolean(loan.settleTxHash);
    const stale = error instanceof AppError && error.code === API_ACCESS_STALE_CODE;
    if (!released && error instanceof AppError && (stale || error.message === RENTAL_EXPIRED || error.code === "api_not_available_for_profile")) {
      console.log(stale
        ? `[reaper] pass d'accès API EVM ${loan.id} caduc (couverture ou échéance changée depuis le devis) : refusé, remboursement à l'échéance`
        : `[reaper] pack d'appels EVM ${loan.id} : location d'origine close, remboursement à l'échéance`);
      await releaseFastTier(loan.id);
      return;
    }
    if (error instanceof AppError && (error.message === CALLS_PENDING || error.message === API_ACCESS_PENDING)) return;
    throw error;
  }
}

/**
 * Achat rendu sans reprise possible (refusé, échu, location close) : un palier rapide encore
 * marqué sur la ligne ESCROWED rend sa part du plafond FAST en cours (finality-tier.ts). Gardé par
 * le statut et le palier seuls : une décision concurrente de la page a déjà réclamé la ligne
 * (SETTLING), ou perdra son claim sur `updatedAt`, touché par cette écriture.
 */
async function releaseFastTier(loanId: string): Promise<void> {
  await prisma.loan.updateMany({ where: { id: loanId, status: "ESCROWED", finalityTier: "FAST" }, data: { finalityTier: "FULL" } });
}

/**
 * Prêt FAST déjà SETTLED : verdict à finalité complète (fast-settlement-review.ts). Confirmé ⇒
 * `finalityVerifiedAt`. Divergence ⇒ alerte journalisée, `finalityReview` posé (prédiction
 * et certificat suspendus) et erreur comptée dans la passe : le battement du reaper la fait
 * remonter. Prolongation, pack ou pass : la revue est aussi posée sur le prêt d'origine (s'il
 * n'en a pas déjà une), seul lu par la prédiction, les clés et l'API publique ; elle s'y écrit en
 * premier, pour qu'une passe interrompue la rouvre. Rien n'est retenté ni annulé automatiquement :
 * un opérateur tranche (runbook 20).
 */
async function reviewFastSettledLoan(loan: Loan, now: Date): Promise<void> {
  const open = async (reason: string) => {
    console.error(`[reaper] ALERTE finalité rapide : prêt EVM ${loan.id} — ${reason} ; revue manuelle requise (docs/passage-mainnet/20-finalite-rapide.md)`);
    const originalLoanId = loan.extendsLoanId ?? loan.packForLoanId;
    if (originalLoanId) {
      const kind = loan.extendsLoanId ? "prolongation" : typeof loan.apiAccessDays === "number" ? "pass d'accès API" : "pack d'appels";
      await prisma.loan.updateMany({
        where: { id: originalLoanId, finalityReview: null },
        data: { finalityReview: `${kind} ${loan.id} : ${reason}`, finalityReviewAt: now },
      });
    }
    await prisma.loan.updateMany({
      where: { id: loan.id, status: "SETTLED", finalityTier: "FAST", finalityReview: null },
      data: { finalityReview: reason, finalityReviewAt: now },
    });
    throw new AppError(`Finalité rapide contredite : ${reason}`, 409);
  };
  if (!loan.settleTxHash || !loan.evmLoanKey) return open("hash de release ou clé de prêt absents");
  const binding = await resolveLoanEscrow(loan);
  const verdict = await verifyFastSettlement(getPublicClient(), {
    settleTxHash: loan.settleTxHash as `0x${string}`,
    escrow: binding.escrow,
    onChainStatus: async () => (await readLoan(loan.evmLoanKey as `0x${string}`, binding))?.status ?? null,
  });
  if (verdict.state === "pending") return;
  if (verdict.state === "discrepancy") return open(verdict.reason);
  await prisma.loan.updateMany({
    where: { id: loan.id, status: "SETTLED", finalityTier: "FAST", finalityVerifiedAt: null },
    data: { finalityVerifiedAt: now },
  });
  console.log(`[reaper] prêt EVM ${loan.id} : release rapide confirmé à finalité complète`);
}

/**
 * Clôture le prêt en base si la chaîne l'a déjà réglé ou remboursé (`closed`). Sinon, renvoie l'état
 * on-chain (`active`, ou `settled` pour un prêt v7 dont la preuve reste à valider) ou `unbound`
 * (lock absent) : le reaper choisit alors la suite sans relire la chaîne.
 */
async function reconcileClosedLoan(loan: Loan): Promise<"closed" | "active" | "settled" | "unbound"> {
  if (!loan.evmLoanKey || !loan.evmLockBlock) return "unbound";
  // Release d'un prêt rapide : accepté au palier rapide (le runner revérifie la profondeur), puis
  // revu à finalité complète une fois SETTLED (`reviewFastSettledLoan`). Coupe-circuit fermé
  // (`SIRIUS_FAST_FINALITY` off) : palier effectif FULL, comme partout ailleurs.
  const state = await reconcileLoanEscrow(
    loan.evmLoanKey as `0x${string}`, BigInt(loan.evmLockBlock), await resolveLoanEscrow(loan), effectiveLoanFinalityTier(loan.finalityTier),
  );
  if (state.state === "active") return "active";
  // La reprise du résultat et la validation de sa preuve précèdent toujours le règlement v7.
  if (state.state === "settled" && loan.billingQuoteHash) return "settled";
  await prisma.loan.updateMany({
    where: { id: loan.id, status: loan.status, updatedAt: loan.updatedAt },
    data: state.state === "settled"
      ? { status: "SETTLED", settleTxHash: state.txHash, settledAt: new Date() }
      : { status: "CANCELLED", cancelTxHash: state.txHash,
        ...(state.retainedFee !== undefined ? { retainedFeeUsdcAtomic: state.retainedFee, refundAmountUsdcAtomic: state.refundAmount } : {}) },
  });
  return "closed";
}
