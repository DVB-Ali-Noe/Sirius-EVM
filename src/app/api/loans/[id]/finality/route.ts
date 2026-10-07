import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getPublicClient } from "@/lib/evm/client";
import { lockFinalityStatus } from "@/lib/evm/finality";
import type { LockFinalityResponse } from "@/lib/evm/lock-finality";
import { requireAuth, assertOwner } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";

export const runtime = "nodejs";

// La page Train relit au plus toutes les 20 s par prêt en attente : trente lectures par
// minute et par compte couvrent plusieurs prêts sans ouvrir une rafale RPC.
const finalityLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 30, maxGlobal: 600 });

/**
 * Le lock de ce prêt est-il déjà sous le bloc stable ? Lecture seule, réservée à l'emprunteur,
 * sans effet sur le prêt ni sur le budget runner : la décision reste celle de `POST …/run`
 * (`assertBlockStable`), ceci ne sert qu'à afficher l'attente et à déclencher le lancement
 * au bon moment quand la page reste ouverte.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(finalityLimiter, `subject:${session.address}`);
    const { id } = await params;
    const loan = await prisma.loan.findUnique({ where: { id }, select: { borrower: true, status: true, evmLockBlock: true } });
    if (!loan) return NextResponse.json({ error: "Loan introuvable" }, { status: 404 });
    assertOwner(session, loan.borrower);
    const idle: LockFinalityResponse = { pending: false, estimatedReadyAt: null };
    // Seul un prêt ESCROWED est retenu par la finalité du lock (`prepareLoanResult`).
    if (loan.status !== "ESCROWED" || !loan.evmLockBlock) return NextResponse.json(idle);
    const estimate = await lockFinalityStatus(getPublicClient(), BigInt(loan.evmLockBlock));
    const body: LockFinalityResponse = estimate.pending
      ? { pending: true, estimatedReadyAt: new Date(estimate.estimatedReadyAt).toISOString() }
      : idle;
    return NextResponse.json(body);
  } catch (err) {
    return errorResponse(err);
  }
}
