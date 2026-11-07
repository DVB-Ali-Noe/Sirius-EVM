import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { assertAuthenticGrant, assertOwner, requireAuth } from "@/lib/auth/require-auth";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import { isCallPackSize } from "@/lib/billing/api-pricing";
import { RunnerFinalityPending } from "@/lib/runner/failure-policy";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { CALLS_PENDING } from "@/lib/loans/settlement-status";
import { loanRouteErrorResponse, requireRunnerOrWake } from "@/lib/sirius/availability";
import { prepareCallPack, settleCallPack } from "@/lib/sirius/calls";

export const runtime = "nodejs";

// Mêmes bornes que la préparation et le règlement d'une prolongation.
const preparationLimiter = new FixedWindowRateLimiter({ windowMs: 600_000, maxPerKey: 10, maxGlobal: 600 });
const settlementLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 10, maxGlobal: 100 });

/**
 * Achat d'un pack d'appels API (D-30) pour le prêt loué `id`, par son emprunteur, en deux temps :
 * - `{ size }` (100, 1 000 ou 10 000) : prépare un prêt de pack (`packForLoanId` = `id`), même flux
 *   de lock qu'une prolongation (approbation, `/authorize`, lock, `/submit` sur le prêt renvoyé) ;
 * - `{ packLoanId, authorization }` : une fois ce lock confirmé, demande au runner le `release` et le
 *   crédit (`buy-calls`, grant `{ loanId: packLoanId }`). Rejouable : le pack n'est crédité qu'une fois.
 * Refusé pour un autre compte, la régression linéaire, un profil sans API et une location échue.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const body = await readJson<{ size?: unknown; packLoanId?: unknown; authorization?: RunnerGrant }>(req);

    if (body.packLoanId === undefined) {
      enforceRateLimit(preparationLimiter, `subject:${session.address}`);
      if (!isCallPackSize(body.size)) return NextResponse.json({ error: "Taille de pack d’appels invalide" }, { status: 400 });
      const { loan, approveTransaction, lockTransaction, billingQuote } = await prepareCallPack(id, session.address, body.size);
      return NextResponse.json({ loanId: loan.id, approveTransaction, lockTransaction, billingQuote }, { status: 201 });
    }

    enforceRateLimit(settlementLimiter, `subject:${session.address}`);
    if (typeof body.packLoanId !== "string" || !body.packLoanId) return NextResponse.json({ error: "Pack d’appels manquant" }, { status: 400 });
    if (!body.authorization) return NextResponse.json({ error: "Autorisation manquante" }, { status: 400 });
    await assertAuthenticGrant(session, body.authorization);
    const pack = await prisma.loan.findUnique({ where: { id: body.packLoanId }, select: { borrower: true, packForLoanId: true } });
    if (!pack || pack.packForLoanId !== id) return NextResponse.json({ error: "Pack d’appels introuvable" }, { status: 404 });
    assertOwner(session, pack.borrower);
    // Pack payé : CVM éteinte ⇒ réveil et 503 ; le reaper le créditera une fois l'enclave allumée.
    await requireRunnerOrWake();
    try {
      return NextResponse.json(await settleCallPack(body.packLoanId, body.authorization));
    } catch (err) {
      if (err instanceof RunnerFinalityPending) {
        return NextResponse.json({ pending: true, settleTxHash: err.transactionHash, error: CALLS_PENDING }, { status: 202 });
      }
      throw err;
    }
  } catch (err) {
    return loanRouteErrorResponse(err);
  }
}
