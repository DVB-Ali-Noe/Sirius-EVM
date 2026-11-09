import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { modelSelection } from "@/lib/models/registry";
import { prepareLoanResult } from "@/lib/sirius/settle";
import { assertAuthenticGrant, requireAuth, assertOwner } from "@/lib/auth/require-auth";
import { readJson } from "@/lib/http/body";
import { hashRunnerIntent } from "@/lib/runner/authorization";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { loanRouteErrorResponse, requireRunnerOrWake } from "@/lib/sirius/availability";

export const runtime = "nodejs";

/**
 * Phase 1 : lance le job, scelle le modèle dans le runner, sans régler l'escrow. Un prêt verrouillé
 * ne garde la CVM allumée que peu après son lock (D-30, audit E F2) : l'emprunteur qui revient
 * plus tard la réveille ici, au budget de son compte. Tout ce qui se vérifie sans le runner passe
 * avant le réveil et avant le passage en TRAINING : prêt ordinaire à lui, ESCROWED ou TRAINING sans
 * modèle, lock non échu (sinon 409 direct, rien d'écrit ni relayé), et grant `run-loan-job` portant
 * exactement le périmètre que l'enclave vérifiera (opération, prêt, dataset, intention ; le rejeu,
 * lui, reste consommé par l'enclave seule). 503 `enclave_starting` le temps du démarrage.
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
      select: { borrower: true, datasetId: true, status: true, modelCid: true, evmDeadline: true, extendsLoanId: true, packForLoanId: true },
    });
    if (!loan) return NextResponse.json({ error: "Loan introuvable" }, { status: 404 });
    assertOwner(session, loan.borrower);
    // Mêmes refus que `prepareLoanResult`, rendus sans réveil ni passage en TRAINING.
    if (loan.extendsLoanId) throw new AppError("Une prolongation ne lance aucun entraînement", 409);
    if (loan.packForLoanId) throw new AppError("Un pack d’appels ne lance aucun entraînement", 409);
    if (loan.status !== "ESCROWED" && (loan.status !== "TRAINING" || loan.modelCid)) {
      throw new AppError("Loan non verrouillé ou déjà en cours", 409);
    }
    if (loan.evmDeadline && loan.evmDeadline.getTime() <= Date.now()) {
      throw new AppError("Lock de paiement échu : aucun entraînement possible, rembourse le prêt", 409);
    }
    const dataset = await prisma.dataset.findUnique({
      where: { id: loan.datasetId },
      select: { runnerReceipt: true, modelId: true, modelVersion: true },
    });
    if (!dataset?.runnerReceipt) throw new AppError("Dataset EVM indisponible", 409);
    // Même profil que celui transmis au runner par `prepareLoanResult` (`modelSelection` du dataset).
    const model = modelSelection(dataset.modelId, dataset.modelVersion);
    if (!model) throw new AppError("Profil d’entraînement du dataset incohérent", 409);
    const scope = authorization.payload;
    if (!scope || scope.operation !== "run-loan-job" || scope.loanId !== id || scope.datasetId !== loan.datasetId
      || scope.jobId !== undefined || scope.demoSessionRevision !== undefined
      || scope.payloadHash !== hashRunnerIntent([id, loan.datasetId, dataset.runnerReceipt, model.modelId, model.modelVersion, "served"])) {
      throw new AppError("Grant runner hors scope ou expiré", 401);
    }
    await requireRunnerOrWake({ wakeSubject: session.address });
    const result = await prepareLoanResult(id, authorization);
    return NextResponse.json(result);
  } catch (err) {
    return loanRouteErrorResponse(err);
  }
}
