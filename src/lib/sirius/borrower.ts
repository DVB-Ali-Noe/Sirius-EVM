import "server-only";
import { decode, hashes, unixTimeToRippleTime } from "xrpl";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { hasAcceptedKyb } from "@/lib/xrpl/credentials";
import { buildEscrowCreate, reconcileEscrowCreate, submitSignedEscrow } from "@/lib/xrpl/escrow";
import { escrowConditionInRunner } from "@/lib/tee/runner-client";
import {
  BORROWABLE_STATUSES,
  isBorrowableDatasetStatus,
} from "@/lib/sirius/provider";
import { siriusVerifierAddress } from "@/lib/xrpl/verifier";

const DAY_MS = 86_400_000;
const PENDING_LOAN_TTL_MS = 10 * 60_000;
const MAX_PENDING_LOANS = 5; // plafond d'emprunts non signés par borrower (anti-spam)
const RATE_WINDOW_MS = 3_600_000; // 1 h : fenêtre anti-accumulation par borrower+dataset (D-18)
const MAX_RUNS_PER_WINDOW = 3; // friction temporelle contre l'exfiltration par runs répétés

/**
 * Phase 1 — prépare l'emprunt : gating KYB borrower bloquant → Loan PENDING →
 * `EscrowCreate` autofillé (non signé) à signer par le wallet du borrower.
 * Le backend ne détient jamais la clé du borrower (cf D-13/D-20, inc.3b.3b).
 */
export async function prepareLoan(
  datasetId: string,
  borrower: string,
) {
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } });
  if (!dataset) throw new AppError("Dataset introuvable", 404);
  if (!isBorrowableDatasetStatus(dataset.status)) throw new AppError("Dataset non disponible", 409);
  if (dataset.provider === borrower) throw new AppError("Un provider ne peut pas emprunter son propre dataset", 400);

  if (!(await hasAcceptedKyb(borrower, siriusVerifierAddress()))) {
    throw new AppError("KYB requis : aucun credential KYB accepté pour ce borrower", 403);
  }

  const loan = await prisma.$transaction(async (tx) => {
    const [pending, recentRuns] = await Promise.all([
      tx.loan.count({ where: { borrower, status: { in: ["PENDING", "SUBMITTING"] } } }),
      tx.loan.count({
        where: { borrower, datasetId, createdAt: { gte: new Date(Date.now() - RATE_WINDOW_MS) } },
      }),
    ]);
    if (pending >= MAX_PENDING_LOANS) {
      throw new AppError("Trop d'emprunts en attente de signature — finalise ou abandonne les précédents", 429);
    }
    if (recentRuns >= MAX_RUNS_PER_WINDOW) {
      throw new AppError("Trop d'emprunts récents sur ce dataset — réessaie plus tard", 429);
    }

    const reservation = await tx.dataset.updateMany({
      where: {
        id: dataset.id,
        status: { in: [...BORROWABLE_STATUSES] },
        wrappedKey: { not: null },
        runnerReceipt: { not: null },
      },
      data: { updatedAt: new Date() },
    });
    if (reservation.count !== 1) throw new AppError("Dataset non disponible", 409);
    return tx.loan.create({
      data: {
        datasetId: dataset.id,
        borrower,
        provider: dataset.provider,
        amount: dataset.priceDrops,
        currency: "XRP",
      },
    });
  });

  try {
    // Condition dérivée du loanId : le fulfillment doit correspondre au release (settle.ts).
    const { conditionHex } = await escrowConditionInRunner(loan.id, borrower);
    // Aligné à la seconde pleine : unixTimeToRippleTime arrondit, on garantit ainsi
    // une comparaison stable prepare/finalize (cf. contrôle CancelAfter du blob).
    const cancelAfter = new Date(
      Math.floor((Date.now() + dataset.challengeDays * DAY_MS + PENDING_LOAN_TTL_MS) / 1000) * 1000,
    );
    const transaction = await buildEscrowCreate(
      borrower,
      dataset.provider,
      dataset.priceDrops,
      conditionHex,
      cancelAfter,
    );
    if (!Number.isSafeInteger(transaction.Sequence) || !Number.isSafeInteger(transaction.LastLedgerSequence)) {
      throw new AppError("EscrowCreate autofillé sans bornes ledger", 503);
    }

    const prepared = await prisma.loan.update({
      where: { id: loan.id },
      data: {
        conditionHex,
        cancelAfter,
        escrowSequence: transaction.Sequence,
        escrowLastLedger: transaction.LastLedgerSequence,
      },
    });
    return { loan: prepared, transaction };
  } catch (err) {
    await prisma.loan.delete({ where: { id: loan.id } }).catch(() => {});
    throw err;
  }
}

/**
 * Phase 2 — finalise : vérifie que le blob signé correspond EXACTEMENT au Loan
 * préparé (anti-substitution), puis le soumet. Le Loan passe PENDING → SUBMITTING → ESCROWED.
 * L'authenticité de l'`Account` est garantie par le ledger (rejet si mauvaise signature).
 */
export async function finalizeLoan(loanId: string, borrower: string, submittedBlob?: string) {
  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    omit: { escrowTxBlob: false },
    include: { dataset: { select: { status: true, wrappedKey: true, runnerReceipt: true } } },
  });
  if (!loan) throw new AppError("Loan introuvable", 404);
  if (loan.borrower !== borrower) throw new AppError("Accès refusé : emprunt d'un autre compte", 403);
  if (loan.status !== "PENDING" && loan.status !== "SUBMITTING") {
    throw new AppError("Emprunt déjà escrow ou clôturé", 409);
  }
  if (!loan.conditionHex || !loan.cancelAfter) throw new AppError("Emprunt non préparé", 409);
  if (loan.status === "PENDING" && Date.now() - loan.createdAt.getTime() > PENDING_LOAN_TTL_MS) {
    await prisma.loan.updateMany({ where: { id: loan.id, status: "PENDING" }, data: { status: "CANCELLED" } });
    throw new AppError("Préparation expirée — recommence l’emprunt", 409);
  }

  const txBlob = submittedBlob || loan.escrowTxBlob;
  if (!txBlob) throw new AppError("Transaction signée manquante", 400);
  let decoded: Record<string, unknown>;
  try {
    decoded = decode(txBlob) as Record<string, unknown>;
  } catch {
    throw new AppError("Transaction signée illisible", 400);
  }

  // Contrôle exhaustif : le blob signé doit correspondre AU CHAMP PRÈS au Loan préparé.
  // CancelAfter inclus → un client ne peut pas raccourcir/supprimer la fenêtre de challenge.
  const conforme =
    decoded.TransactionType === "EscrowCreate" &&
    decoded.Account === loan.borrower &&
    decoded.Destination === loan.provider &&
    decoded.Amount === loan.amount &&
    decoded.Condition === loan.conditionHex &&
    decoded.CancelAfter === unixTimeToRippleTime(loan.cancelAfter.getTime()) &&
    Number.isSafeInteger(decoded.Sequence) &&
    decoded.Sequence === loan.escrowSequence &&
    Number.isSafeInteger(decoded.LastLedgerSequence) &&
    decoded.LastLedgerSequence === loan.escrowLastLedger;
  if (!conforme) throw new AppError("Transaction signée non conforme à l'emprunt", 400);
  const escrowSequence = Number(decoded.Sequence);
  const escrowLastLedger = Number(decoded.LastLedgerSequence);
  const escrowTxHash = hashes.hashSignedTx(txBlob);
  if (
    loan.status === "SUBMITTING" &&
    (loan.escrowTxHash !== escrowTxHash ||
      loan.escrowSequence !== escrowSequence ||
      loan.escrowLastLedger !== escrowLastLedger ||
      loan.escrowTxBlob !== txBlob)
  ) {
    throw new AppError("Une autre transaction EscrowCreate est déjà en réconciliation", 409);
  }

  // Le dataset a pu être supprimé (crypto-shredding) ou délisté entre prepare et finalize :
  // refuser de verrouiller des fonds en escrow sur une data devenue indisponible.
  if (loan.status === "PENDING" && (
    !isBorrowableDatasetStatus(loan.dataset.status) ||
    !loan.dataset.wrappedKey ||
    !loan.dataset.runnerReceipt
  )) {
    throw new AppError("Dataset indisponible (supprimé ou privé) — emprunt non finalisable", 409);
  }

  if (loan.status === "PENDING") await prisma.$transaction(async (tx) => {
    const available = await tx.dataset.updateMany({
      where: {
        id: loan.datasetId,
        status: { in: [...BORROWABLE_STATUSES] },
        wrappedKey: { not: null },
        runnerReceipt: { not: null },
      },
      data: { updatedAt: new Date() },
    });
    if (available.count !== 1) throw new AppError("Dataset indisponible", 409);
    const claim = await tx.loan.updateMany({
      where: { id: loan.id, status: "PENDING" },
      data: { status: "SUBMITTING", escrowSequence, escrowTxHash, escrowTxBlob: txBlob, escrowLastLedger },
    });
    if (claim.count !== 1) throw new AppError("Emprunt déjà en cours de règlement", 409);
  });

  let txHash: string;
  try {
    txHash = await submitSignedEscrow(txBlob);
  } catch {
    const reconciliation = await reconcileEscrowCreate(escrowTxHash, escrowLastLedger);
    if (reconciliation === "confirmed") {
      txHash = escrowTxHash;
    } else if (reconciliation === "failed") {
      await prisma.loan.updateMany({
        where: { id: loan.id, status: "SUBMITTING", escrowTxHash },
        data: { status: "CANCELLED", escrowTxBlob: null },
      });
      throw new AppError("EscrowCreate rejeté ou expiré — recommence l’emprunt", 409);
    } else {
      throw new AppError("EscrowCreate soumis, confirmation XRPL en attente", 503);
    }
  }

  if (txHash !== escrowTxHash) throw new AppError("Hash EscrowCreate incohérent", 502);

  const confirmed = await prisma.loan.updateMany({
    where: { id: loan.id, status: "SUBMITTING", escrowTxHash: txHash },
    data: { status: "ESCROWED", escrowSequence, escrowTxHash: txHash, escrowTxBlob: null },
  });
  if (confirmed.count !== 1) throw new AppError("EscrowCreate confirmé mais état local incohérent", 409);
  return prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
}
