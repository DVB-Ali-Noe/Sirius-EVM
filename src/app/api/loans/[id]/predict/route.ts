import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { assertAuthenticGrant, assertOwner, requireAuth } from "@/lib/auth/require-auth";
import { AppError, errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import { phalaDemoInstance } from "@/lib/sirius/self-training-access";
import { requireAcceptedKyb } from "@/lib/sirius/access";
import { effectiveLoanFinalityTier } from "@/lib/sirius/finality-tier";
import { assertSignedPrediction, isServedModelFingerprint, parsePredictionRequest, predictionSessionRevision } from "@/lib/sirius/prediction";
import { modelSelection } from "@/lib/models/registry";
import { assertCurrentRunner } from "@/lib/runner/provenance";
import { predictInRunner } from "@/lib/tee/runner-client";

export const runtime = "nodejs";

const predictionLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 20, maxGlobal: 200 });

/**
 * Prédiction signée sur le modèle d'un emprunt réglé, scellé dans le runner ; réservée à
 * l'emprunteur. Le runner revérifie le reçu de prêt et le règlement publié (`settleTxHash`,
 * palier de finalité) avant tout calcul : un prêt non réglé ou en revue de finalité est refusé ici.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(predictionLimiter, `subject:${session.address}`);
    const { id } = await params;
    const { features, authorization } = parsePredictionRequest(await readJson(req));
    await assertAuthenticGrant(session, authorization);
    const loan = await prisma.loan.findUnique({ where: { id } });
    if (!loan) return NextResponse.json({ error: "Loan introuvable" }, { status: 404 });
    assertOwner(session, loan.borrower);
    if (loan.status !== "SETTLED" || loan.finalityReview || !loan.runnerReceipt || !loan.settleTxHash) {
      return NextResponse.json({ error: "Règlement du prêt non confirmé" }, { status: 409 });
    }
    const model = modelSelection(loan.modelId, loan.modelVersion);
    if (!isServedModelFingerprint(loan.modelCid) || !model) {
      return NextResponse.json({ error: "Modèle indisponible" }, { status: 409 });
    }
    const ref = { kind: "loan", id } as const;
    const sessionRevision = await predictionSessionRevision(ref, authorization);
    await requireAcceptedKyb(session.address);
    const provenance = await assertCurrentRunner(loan);
    if (phalaDemoInstance() && provenance.runnerKind !== "PHALA") throw new AppError("Runner Phala requis", 503);
    const result = await predictInRunner(ref, features, authorization, {
      loanReceipt: loan.runnerReceipt,
      settleTxHash: loan.settleTxHash,
      finalityTier: effectiveLoanFinalityTier(loan.finalityTier),
    });
    const prediction = await assertSignedPrediction(result, {
      ref, modelId: model.modelId, modelVersion: model.modelVersion, subject: session.address, features, sessionRevision,
    });
    return NextResponse.json(prediction, { headers: { "cache-control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
