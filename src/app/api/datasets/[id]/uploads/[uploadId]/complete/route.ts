import { NextResponse } from "next/server";
import { assertAuthenticGrant, requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { parseRunnerGrantHeader } from "@/lib/runner/authorization-contract";
import { MAX_COMPLETE_BODY_BYTES, completeDatasetUpload } from "@/lib/sirius/chunked-upload";

export const runtime = "nodejs";

/**
 * Clôture : vérifie le manifeste et la présence de chaque morceau, puis demande le scellement à
 * l'enclave avec le grant du fournisseur. Répond 202 : l'état se suit sur `GET …/[uploadId]`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; uploadId: string }> }) {
  try {
    const session = requireAuth(req);
    const { id, uploadId } = await params;
    const authorization = parseRunnerGrantHeader(req.headers.get("x-sirius-runner-grant"));
    if (!authorization) {
      return NextResponse.json({ error: "Autorisation runner manquante" }, { status: 400 });
    }
    await assertAuthenticGrant(session, authorization);
    const { manifest } = await readJson<{ manifest?: unknown }>(req, MAX_COMPLETE_BODY_BYTES);
    if (!manifest) return NextResponse.json({ error: "Manifeste manquant" }, { status: 400 });
    return NextResponse.json(await completeDatasetUpload(id, uploadId, session.address, manifest, authorization), { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
