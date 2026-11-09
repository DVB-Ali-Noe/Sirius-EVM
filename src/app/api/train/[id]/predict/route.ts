import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { assertAuthenticGrant, assertOwner, requireAuth } from "@/lib/auth/require-auth";
import { AppError, errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import { assertSelfTrainingAccess, phalaDemoInstance } from "@/lib/sirius/self-training-access";
import { requireAcceptedKyb } from "@/lib/sirius/access";
import { assertSignedPrediction, parsePredictionRequest, predictionSessionRevision } from "@/lib/sirius/prediction";
import { isServedModelFingerprint, modelSelection } from "@/lib/models/registry";
import { assertCurrentRunner } from "@/lib/runner/provenance";
import { predictInRunner } from "@/lib/tee/runner-client";

export const runtime = "nodejs";

const predictionLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 20, maxGlobal: 200 });

/** Prédiction signée sur le modèle d'un self-train, scellé dans le runner ; réservée au propriétaire du job. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    assertSelfTrainingAccess(session, true);
    enforceRateLimit(predictionLimiter, `subject:${session.address}`);
    const { id } = await params;
    const { features, authorization } = parsePredictionRequest(await readJson(req));
    await assertAuthenticGrant(session, authorization);
    const job = await prisma.trainingJob.findUnique({ where: { id } });
    if (!job) return NextResponse.json({ error: "Modèle introuvable" }, { status: 404 });
    assertOwner(session, job.owner);
    const model = modelSelection(job.modelId, job.modelVersion);
    if (job.status !== "DONE" || job.servedModelId !== id || !isServedModelFingerprint(job.modelCid) || !model) {
      return NextResponse.json({ error: "Modèle indisponible" }, { status: 409 });
    }
    const ref = { kind: "job", id } as const;
    const sessionRevision = await predictionSessionRevision(ref, authorization);
    await requireAcceptedKyb(session.address);
    const provenance = await assertCurrentRunner(job);
    if (phalaDemoInstance() && provenance.runnerKind !== "PHALA") throw new AppError("Runner Phala requis", 503);
    const prediction = await assertSignedPrediction(await predictInRunner(ref, features, authorization), {
      ref, modelId: model.modelId, modelVersion: model.modelVersion, subject: session.address, features, sessionRevision,
    });
    return NextResponse.json(prediction, { headers: { "cache-control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
