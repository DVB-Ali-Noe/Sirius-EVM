import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { assertAuthenticGrant, assertOwner, requireAuth } from "@/lib/auth/require-auth";
import { loanRouteErrorResponse } from "@/lib/sirius/availability";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import { isValidRentalDays } from "@/lib/billing/rental";
import { RunnerFinalityPending } from "@/lib/runner/failure-policy";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { EXTENSION_PENDING } from "@/lib/loans/settlement-status";
import { prepareLoanExtension, settleLoanExtension } from "@/lib/sirius/extend";

export const runtime = "nodejs";

// Même borne que la préparation d'un emprunt (devis signé, PENDING remplacé) et que le règlement.
const preparationLimiter = new FixedWindowRateLimiter({ windowMs: 600_000, maxPerKey: 10, maxGlobal: 600 });
const settlementLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 10, maxGlobal: 100 });

/**
 * Prolongation de la location du prêt `id` (D-29), par son emprunteur, en deux temps :
 * - `{ rentalDays }` : prépare un prêt de prolongation (`extendsLoanId` = `id`), même flux de lock
 *   qu'un emprunt (approbation, `/authorize`, lock, `/submit` sur le prêt renvoyé) ;
 * - `{ extensionLoanId, authorization }` : une fois ce lock confirmé, demande au runner le `release`
 *   (`extend-loan`, grant `{ loanId: extensionLoanId }`) et reporte l'échéance sur le prêt `id`.
 * Refusé pour un autre compte, un prêt hérité sans durée et un modèle déjà supprimé.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const body = await readJson<{ rentalDays?: unknown; extensionLoanId?: unknown; authorization?: RunnerGrant }>(req);

    if (body.extensionLoanId === undefined) {
      enforceRateLimit(preparationLimiter, `subject:${session.address}`);
      if (!isValidRentalDays(body.rentalDays)) return NextResponse.json({ error: "Durée de location invalide" }, { status: 400 });
      const { loan, approveTransaction, lockTransaction, billingQuote } = await prepareLoanExtension(id, session.address, body.rentalDays);
      return NextResponse.json({ loanId: loan.id, approveTransaction, lockTransaction, billingQuote }, { status: 201 });
    }

    enforceRateLimit(settlementLimiter, `subject:${session.address}`);
    if (typeof body.extensionLoanId !== "string" || !body.extensionLoanId) {
      return NextResponse.json({ error: "Prolongation manquante" }, { status: 400 });
    }
    if (!body.authorization) return NextResponse.json({ error: "Autorisation manquante" }, { status: 400 });
    await assertAuthenticGrant(session, body.authorization);
    const extension = await prisma.loan.findUnique({ where: { id: body.extensionLoanId }, select: { borrower: true, extendsLoanId: true } });
    if (!extension || extension.extendsLoanId !== id) return NextResponse.json({ error: "Prolongation introuvable" }, { status: 404 });
    assertOwner(session, extension.borrower);
    try {
      return NextResponse.json(await settleLoanExtension(body.extensionLoanId, body.authorization));
    } catch (err) {
      if (err instanceof RunnerFinalityPending) {
        return NextResponse.json({ pending: true, settleTxHash: err.transactionHash, error: EXTENSION_PENDING }, { status: 202 });
      }
      throw err;
    }
  } catch (err) {
    return loanRouteErrorResponse(err);
  }
}
