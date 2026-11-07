import "server-only";
import type { Hex } from "viem";
import type { Loan } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { addressesEqual } from "@/lib/evm/address";
import { getPublicClient } from "@/lib/evm/client";
import { DAY_MS, RENTAL_GRACE_DAYS } from "@/lib/billing/rental";

/**
 * Location des modèles de prêt (D-29), côté Next. L'échéance d'un prêt vaut l'horodatage du bloc
 * de son `release` + `rentalDays` jours, comme dans le runner, qui l'applique lui aussi. Un prêt
 * hérité (`rentalDays` nul, devis d'avant D-29) n'expire jamais. Une prolongation repousse
 * l'échéance du prêt d'origine ; le modèle scellé reste prolongeable `RENTAL_GRACE_DAYS` jours
 * après l'échéance, puis le runner le supprime.
 */

export const RENTAL_EXPIRED = "Location expirée : prolonge pour continuer";
export const RENTAL_MODEL_DELETED = "Modèle supprimé : location close";

type RentalLoan = Pick<Loan, "id" | "status" | "settleTxHash" | "rentalDays" | "rentalExpiresAt" | "extendsLoanId" | "packForLoanId">;

/** Échéance d'une location réglée par la transaction `settleTxHash` (bloc du `release`). */
export async function rentalExpiryFromRelease(settleTxHash: string, rentalDays: number): Promise<Date> {
  const client = getPublicClient();
  const receipt = await client.getTransactionReceipt({ hash: settleTxHash as Hex });
  if (receipt.status !== "success") throw new AppError("Release du prêt rejeté", 409);
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  return new Date(Number(block.timestamp) * 1000 + rentalDays * DAY_MS);
}

/**
 * Échéance enregistrée du prêt, ou relue du bloc de `release` puis enregistrée si elle manque
 * (règlement réconcilié sans réponse du runner). `null` : prêt hérité, prolongation, pack d'appels
 * (D-30 : il reprend les jours du prêt d'origine sans échéance propre) ou prêt non réglé.
 * L'écriture ne remplace jamais une échéance déjà posée (une prolongation a pu la repousser).
 */
export async function loanRentalExpiry(loan: RentalLoan): Promise<Date | null> {
  if (loan.rentalExpiresAt) return loan.rentalExpiresAt;
  if (loan.extendsLoanId || loan.packForLoanId || typeof loan.rentalDays !== "number" || loan.status !== "SETTLED" || !loan.settleTxHash) return null;
  const expiresAt = await rentalExpiryFromRelease(loan.settleTxHash, loan.rentalDays);
  const written = await prisma.loan.updateMany({ where: { id: loan.id, rentalExpiresAt: null }, data: { rentalExpiresAt: expiresAt } });
  if (written.count === 1) return expiresAt;
  const stored = await prisma.loan.findUnique({ where: { id: loan.id }, select: { rentalExpiresAt: true } });
  return stored?.rentalExpiresAt ?? expiresAt;
}

/** Le modèle scellé est supprimé (ou en passe de l'être) : échéance + délai de grâce atteints. */
export function isRentalModelDeleted(expiresAt: Date, now: number): boolean {
  return now >= expiresAt.getTime() + RENTAL_GRACE_DAYS * DAY_MS;
}

/**
 * Prêt d'origine prolongeable par `borrower` : prêt ordinaire réglé (release confirmé, hors revue
 * de finalité), à durée signée, dont le modèle scellé n'est pas encore supprimé. Contrôlé avant
 * toute préparation de lock, pour qu'aucun paiement ne vise une location close.
 */
export async function assertExtendableLoan(loanId: string, borrower: string, now = Date.now()) {
  const loan = await prisma.loan.findUnique({ where: { id: loanId } });
  if (!loan) throw new AppError("Loan introuvable", 404);
  if (!addressesEqual(loan.borrower, borrower)) throw new AppError("Accès refusé : emprunt d’un autre compte", 403);
  if (loan.extendsLoanId) throw new AppError("Une prolongation ne se prolonge pas : prolonge le prêt d’origine", 409);
  if (loan.packForLoanId) throw new AppError("Un pack d’appels ne se prolonge pas : prolonge le prêt d’origine", 409);
  if (typeof loan.rentalDays !== "number") throw new AppError("Prêt sans durée de location : rien à prolonger", 409);
  if (loan.status !== "SETTLED" || loan.finalityReview || !loan.settleTxHash || !loan.runnerReceipt) {
    throw new AppError("Règlement du prêt non confirmé", 409);
  }
  const expiresAt = await loanRentalExpiry(loan);
  if (!expiresAt) throw new AppError("Échéance de location inconnue", 409);
  if (isRentalModelDeleted(expiresAt, now)) throw new AppError(RENTAL_MODEL_DELETED, 409);
  return { ...loan, runnerReceipt: loan.runnerReceipt, settleTxHash: loan.settleTxHash, rentalExpiresAt: expiresAt };
}
