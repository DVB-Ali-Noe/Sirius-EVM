import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { prepareLoanResult } from "@/lib/sirius/settle";
import { assertAuthenticGrant, requireAuth, assertOwner } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";

export const runtime = "nodejs";

/** Phase 1 : lance le job, scelle le modèle dans le runner, sans régler l'escrow. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const { authorization } = await readJson<{ authorization?: RunnerGrant }>(req);
    if (!authorization) {
      return NextResponse.json({ error: "Autorisation manquante" }, { status: 400 });
    }
    await assertAuthenticGrant(session, authorization);
    const loan = await prisma.loan.findUnique({ where: { id }, select: { borrower: true } });
    if (!loan) return NextResponse.json({ error: "Loan introuvable" }, { status: 404 });
    assertOwner(session, loan.borrower);
    const result = await prepareLoanResult(id, authorization);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
