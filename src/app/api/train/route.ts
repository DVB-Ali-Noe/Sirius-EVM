import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runSelfTrain } from "@/lib/sirius/self-train";
import { assertAuthenticGrant, requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";

export const runtime = "nodejs";

/** Liste les jobs self-train du compte authentifié. */
export async function GET(req: Request) {
  try {
    const session = requireAuth(req);
    const jobs = await prisma.trainingJob.findMany({
      where: { owner: session.address },
      orderBy: { createdAt: "desc" },
      include: { dataset: { select: { name: true } } },
    });
    return NextResponse.json(jobs);
  } catch (err) {
    return errorResponse(err);
  }
}

/** Lance un self-train autorisé par le wallet ; la clé est demandée séparément après le job. */
export async function POST(req: Request) {
  try {
    const session = requireAuth(req);
    const { datasetId, jobId, datasetReceipt, authorization, deliveryPublicKey } = await readJson<{
      datasetId?: unknown;
      jobId?: unknown;
      datasetReceipt?: unknown;
      authorization?: RunnerGrant;
      deliveryPublicKey?: unknown;
    }>(req);
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
    const result = await runSelfTrain(datasetId, session.address, jobId, datasetReceipt, authorization, deliveryPublicKey as string | undefined);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
