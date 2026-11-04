import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { presignUploadParts } from "@/lib/sirius/chunked-upload";

export const runtime = "nodejs";

/** URL d'envoi pré-signées (15 min, taille signée) pour une liste de morceaux. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; uploadId: string }> }) {
  try {
    const session = requireAuth(req);
    const { id, uploadId } = await params;
    const { indexes } = await readJson<{ indexes?: unknown }>(req);
    return NextResponse.json(await presignUploadParts(id, uploadId, session.address, indexes), {
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
