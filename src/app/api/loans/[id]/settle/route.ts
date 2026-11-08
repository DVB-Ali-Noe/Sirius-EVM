import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { settlePreparedLoan } from "@/lib/sirius/settle";
import { assertAuthenticGrant, assertOwner, requireAuth } from "@/lib/auth/require-auth";
import { loanRouteErrorResponse, requireRunnerServing } from "@/lib/sirius/availability";
import { RunnerFinalityPending } from "@/lib/runner/failure-policy";
import { SETTLEMENT_FINALITY_PENDING, SETTLEMENT_FINALITY_PENDING_FAST } from "@/lib/loans/settlement-status";
import { effectiveLoanFinalityTier } from "@/lib/sirius/finality-tier";
import { readJson } from "@/lib/http/body";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";

export const runtime = "nodejs";

const settlementLimiter = new FixedWindowRateLimiter({
  windowMs: 60_000,
  maxPerKey: 10,
  maxGlobal: 100,
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(settlementLimiter, `subject:${session.address}`);
    const { id } = await params;
    const { authorization } = await readJson<{
      authorization?: RunnerGrant;
    }>(req);
    if (!authorization) {
      return NextResponse.json({ error: "Autorisation manquante" }, { status: 400 });
    }
    await assertAuthenticGrant(session, authorization);
    const loan = await prisma.loan.findUnique({ where: { id }, select: { borrower: true, finalityTier: true, status: true } });
    if (!loan) return NextResponse.json({ error: "Loan introuvable" }, { status: 404 });
    assertOwner(session, loan.borrower);
    // Un prêt à régler garde déjà la CVM voulue (D-30) : contrôle de phase sans réveil, pour ne pas
    // relayer vers une CVM éteinte ou un contrôleur muet (audit E). Le reaper règle sans passer ici.
    if (loan.status !== "SETTLED") await requireRunnerServing();
    try {
      return NextResponse.json(await settlePreparedLoan(id, authorization));
    } catch (err) {
      if (err instanceof RunnerFinalityPending) {
        // L'attente annoncée suit le palier effectif du prêt (coupe-circuit compris) : secondes en
        // rapide, un quart d'heure sinon.
        const error = effectiveLoanFinalityTier(loan.finalityTier) === "FAST" ? SETTLEMENT_FINALITY_PENDING_FAST : SETTLEMENT_FINALITY_PENDING;
        return NextResponse.json({ pending: true, settleTxHash: err.transactionHash, error }, { status: 202 });
      }
      throw err;
    }
  } catch (err) {
    return loanRouteErrorResponse(err);
  }
}
