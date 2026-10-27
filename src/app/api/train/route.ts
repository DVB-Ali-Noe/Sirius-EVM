import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runSelfTrain } from "@/lib/sirius/self-train";
import { assertSelfTrainingAccess, isDemoTrainingGrant, phalaDemoInstance } from "@/lib/sirius/self-training-access";
import { assertAuthenticGrant, requireAuth } from "@/lib/auth/require-auth";
import { AppError, errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { requestDemoController } from "@/lib/phala-demo/controller-client";

export const runtime = "nodejs";

/**
 * Liste les jobs self-train du compte authentifié. Réservé à l'équipe ; sur une instance de
 * démonstration Phala, la page de démo en a besoin pour lister ses propres entraînements.
 */
export async function GET(req: Request) {
  try {
    const session = requireAuth(req);
    assertSelfTrainingAccess(session, true);
    const jobs = await prisma.trainingJob.findMany({
      where: { owner: session.address },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, status: true, modelId: true, modelVersion: true, modelCid: true,
        servedModelId: true, runnerReceipt: true, metrics: true, deliveryPublicKey: true,
        createdAt: true, completedAt: true, dataset: { select: { name: true } },
      },
    });
    return NextResponse.json(jobs.map((job) => job.servedModelId
      ? { ...job, modelCid: null, runnerReceipt: null, deliveryPublicKey: null } : job),
      { headers: { "cache-control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Lance un self-train autorisé par le wallet ; la clé est demandée séparément après le job. */
export async function POST(req: Request) {
  try {
    const session = requireAuth(req);
    // Premier refus avant toute lecture du corps : hors démo, un wallet non admin ne voit
    // même pas le format attendu.
    assertSelfTrainingAccess(session, true);
    const { datasetId, jobId, datasetReceipt, authorization, deliveryPublicKey, served } = await readJson<{
      datasetId?: unknown;
      jobId?: unknown;
      datasetReceipt?: unknown;
      authorization?: RunnerGrant;
      deliveryPublicKey?: unknown;
      served?: unknown;
    }>(req);
    // Second refus : sur une instance de démo, seul un entraînement porté par un grant de
    // démo reste ouvert aux visiteurs. Le runner vérifie ensuite ce grant contre la session.
    assertSelfTrainingAccess(session, isDemoTrainingGrant(authorization));
    if (served !== undefined && served !== true && served !== false) {
      return NextResponse.json({ error: "Mode servi invalide" }, { status: 400 });
    }
    if (served === true) {
      if (process.env.SIRIUS_PREDICT_ENABLED !== "true" || !phalaDemoInstance()) {
        throw new AppError("Prédiction privée indisponible", 403);
      }
      if (deliveryPublicKey !== undefined) {
        return NextResponse.json({ error: "Clé de livraison interdite pour un modèle servi" }, { status: 400 });
      }
      const demo = await requestDemoController();
      if (demo.phase !== "open" || !demo.available || !Number.isSafeInteger(demo.sessionRevision)
        || authorization?.payload?.demoSessionRevision !== demo.sessionRevision) {
        throw new AppError("La démonstration est fermée ou l’autorisation a expiré", 403);
      }
    }
    if (
      typeof datasetId !== "string" ||
      !datasetId ||
      typeof jobId !== "string" ||
      !jobId ||
      typeof datasetReceipt !== "string" ||
      !datasetReceipt ||
      !authorization
    ) {
      return NextResponse.json({ error: "Requête d’entraînement incomplète" }, { status: 400 });
    }
    await assertAuthenticGrant(session, authorization);
    if (deliveryPublicKey !== undefined && (typeof deliveryPublicKey !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(deliveryPublicKey))) {
      return NextResponse.json({ error: "Clé de livraison invalide" }, { status: 400 });
    }
    const result = await runSelfTrain(datasetId, session.address, jobId, datasetReceipt, authorization, deliveryPublicKey as string | undefined, served === true);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
