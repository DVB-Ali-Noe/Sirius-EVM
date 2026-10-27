import { keccak256, stringToHex } from "viem";
import { EVM_CHAIN_IDS } from "@/lib/evm/networks";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth, assertAuthenticGrant, assertOwner } from "@/lib/auth/require-auth";
import { AppError, errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import { phalaDemoInstance } from "@/lib/sirius/self-training-access";
import { requestDemoController } from "@/lib/phala-demo/controller-client";
import { requireAcceptedKyb } from "@/lib/sirius/access";
import { assertCurrentRunner } from "@/lib/runner/provenance";
import { predictInRunner } from "@/lib/tee/runner-client";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";

export const runtime = "nodejs";

const predictionLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 20, maxGlobal: 200 });

export async function POST(req: Request, { params }: { params: Promise<{ cid: string }> }) {
  try {
    const session = requireAuth(req);
    if (process.env.SIRIUS_PREDICT_ENABLED !== "true" || !phalaDemoInstance()) {
      throw new AppError("Prédiction privée indisponible", 403);
    }
    enforceRateLimit(predictionLimiter, `subject:${session.address}`);
    const { cid: id } = await params;
    const { features, authorization } = await readJson<{ features?: unknown; authorization?: RunnerGrant }>(req);
    if (!features || typeof features !== "object" || Array.isArray(features)
      || !Object.keys(features).length || Object.entries(features).some(([name, value]) => !name || typeof value !== "number" || !Number.isFinite(value))
      || !authorization) {
      return NextResponse.json({ error: "Caractéristiques ou autorisation invalides" }, { status: 400 });
    }
    await assertAuthenticGrant(session, authorization);
    const job = await prisma.trainingJob.findUnique({ where: { id } });
    if (!job) return NextResponse.json({ error: "Modèle introuvable" }, { status: 404 });
    assertOwner(session, job.owner);
    if (job.status !== "DONE" || job.servedModelId !== id || job.modelId !== "gradient_boosted_trees"
      || job.modelVersion !== "1.1.0" || job.modelCid || job.deliveryEnvelope || job.deliveryPublicKey) {
      return NextResponse.json({ error: "Modèle servi indisponible" }, { status: 409 });
    }
    const demo = await requestDemoController();
    if (demo.phase !== "open" || !demo.available || !Number.isSafeInteger(demo.sessionRevision)
      || authorization.payload?.operation !== "predict" || authorization.payload.jobId !== id
      || authorization.payload.demoSessionRevision !== demo.sessionRevision) {
      throw new AppError("La démonstration est fermée ou l’autorisation a expiré", 403);
    }
    await requireAcceptedKyb(session.address);
    const provenance = await assertCurrentRunner(job);
    if (provenance.runnerKind !== "PHALA") throw new AppError("Runner Phala requis", 503);
    const result = await predictInRunner(id, features as Record<string, number>, authorization);
    if (result.modelId !== id || result.modelVersion !== job.modelVersion || (result.decision !== 0 && result.decision !== 1)
      || !Number.isSafeInteger(result.counter) || result.counter < 1
      || typeof result.signer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(result.signer)
      || typeof result.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(result.signature)
      || !result.signedMessage || !result.domain
      || result.domain.name !== "SiriusPrediction" || result.domain.version !== "1"
      || result.domain.chainId !== EVM_CHAIN_IDS.testnet
      || result.signedMessage.modelId !== id || result.signedMessage.modelVersion !== job.modelVersion
      || typeof result.signedMessage.subject !== "string" || result.signedMessage.subject.toLowerCase() !== session.address.toLowerCase()
      || result.signedMessage.featuresHash !== keccak256(stringToHex(JSON.stringify(features)))
      || result.signedMessage.decision !== result.decision || result.signedMessage.counter !== result.counter
      || result.signedMessage.sessionRevision !== demo.sessionRevision) throw new AppError("Réponse de prédiction invalide", 502);
    return NextResponse.json({ modelId: result.modelId, modelVersion: result.modelVersion, decision: result.decision,
      counter: result.counter, signature: result.signature, signer: result.signer, domain: result.domain,
      signedMessage: result.signedMessage }, { headers: { "cache-control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
