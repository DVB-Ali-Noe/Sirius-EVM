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
 * démonstration Phala, la page de démo en a besoin pour lister ses propres entraînements. Aucune
 * empreinte, aucun reçu ni champ de livraison ne sort : le modèle ne s'utilise que par prédiction.
 */
export async function GET(req: Request) {
  try {
    const session = requireAuth(req);
    assertSelfTrainingAccess(session, true);
    const jobs = await prisma.trainingJob.findMany({
      where: { owner: session.address },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, status: true, modelId: true, modelVersion: true, servedModelId: true, metrics: true,
        createdAt: true, completedAt: true, dataset: { select: { name: true } },
      },
    });
    return NextResponse.json(jobs, { headers: { "cache-control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Lance un self-train autorisé par le wallet ; le modèle reste scellé dans le runner. */
export async function POST(req: Request) {
  try {
    const session = requireAuth(req);
    // Premier refus avant toute lecture du corps : hors démo, un wallet non admin ne voit
    // même pas le format attendu.
    assertSelfTrainingAccess(session, true);
    const { datasetId, jobId, datasetReceipt, authorization } = await readJson<{
      datasetId?: unknown;
      jobId?: unknown;
      datasetReceipt?: unknown;
      authorization?: RunnerGrant;
    }>(req);
    // Second refus : sur une instance de démo, seul un entraînement porté par un grant de
    // démo reste ouvert aux visiteurs. Le runner vérifie ensuite ce grant contre la session.
    assertSelfTrainingAccess(session, isDemoTrainingGrant(authorization));
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
    if (phalaDemoInstance()) {
      const demo = await requestDemoController();
      if (demo.phase !== "open" || !demo.available || !Number.isSafeInteger(demo.sessionRevision)
        || authorization.payload?.demoSessionRevision !== demo.sessionRevision) {
        throw new AppError("La démonstration est fermée ou l’autorisation a expiré", 403);
      }
    }
    await assertAuthenticGrant(session, authorization);
    const result = await runSelfTrain(datasetId, session.address, jobId, datasetReceipt, authorization);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
