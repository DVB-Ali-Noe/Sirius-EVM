import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { prepareLoanResult } from "@/lib/sirius/settle";
import { assertAuthenticGrant, requireAuth, assertOwner } from "@/lib/auth/require-auth";
import { readJson } from "@/lib/http/body";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { loanRouteErrorResponse, requireRunnerOrWake } from "@/lib/sirius/availability";

export const runtime = "nodejs";

/**
 * Phase 1 : lance le job, scelle le modèle dans le runner, sans régler l'escrow. Un prêt verrouillé
 * ne garde la CVM allumée que peu après son lock (D-30, audit E F2) : l'emprunteur qui revient
 * plus tard la réveille ici, au budget de son compte, une fois les contrôles en lecture seule
 * passés (prêt ordinaire à lui, ESCROWED ou TRAINING sans modèle, lock non échu) ; 503
 * `enclave_starting` le temps du démarrage, rien n'est écrit sur le prêt.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const { authorization } = await readJson<{ authorization?: RunnerGrant }>(req);
    if (!authorization) {
      return NextResponse.json({ error: "Autorisation manquante" }, { status: 400 });
    }
    await assertAuthenticGrant(session, authorization);
    const loan = await prisma.loan.findUnique({
      where: { id },
      select: { borrower: true, status: true, modelCid: true, evmDeadline: true, extendsLoanId: true, packForLoanId: true },
    });
    if (!loan) return NextResponse.json({ error: "Loan introuvable" }, { status: 404 });
    assertOwner(session, loan.borrower);
    const runnable = !loan.extendsLoanId && !loan.packForLoanId
      && (loan.status === "ESCROWED" || (loan.status === "TRAINING" && !loan.modelCid))
      && (loan.evmDeadline === null || loan.evmDeadline.getTime() > Date.now());
    // Refus de `prepareLoanResult` (prolongation, pack, prêt non verrouillé) rendus sans réveil.
    if (runnable) await requireRunnerOrWake({ wakeSubject: session.address });
    const result = await prepareLoanResult(id, authorization);
    return NextResponse.json(result);
  } catch (err) {
    return loanRouteErrorResponse(err);
  }
}
