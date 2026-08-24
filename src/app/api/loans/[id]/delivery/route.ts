import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { replaceLoanDelivery } from "@/lib/sirius/settle";
import { assertGrantSubject, assertOwner, requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";

export const runtime = "nodejs";

const deliveryLimiter = new FixedWindowRateLimiter({
  windowMs: 60_000,
  maxPerKey: 10,
  maxGlobal: 100,
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(deliveryLimiter, `subject:${session.address}`);
    const { id } = await params;
    const { authorization, deliveryPublicKey } = await readJson<{
      authorization?: RunnerGrant;
      deliveryPublicKey?: unknown;
    }>(req);
    if (!authorization || typeof deliveryPublicKey !== "string") {
      return NextResponse.json({ error: "Autorisation ou clé de livraison manquante" }, { status: 400 });
    }
    assertGrantSubject(session, authorization);
    const loan = await prisma.loan.findUnique({ where: { id }, select: { borrower: true } });
    if (!loan) return NextResponse.json({ error: "Loan introuvable" }, { status: 404 });
    assertOwner(session, loan.borrower);
    return NextResponse.json(await replaceLoanDelivery(id, deliveryPublicKey, authorization));
  } catch (err) {
    return errorResponse(err);
  }
}
