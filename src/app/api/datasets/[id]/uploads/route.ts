import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { openDatasetUpload } from "@/lib/sirius/chunked-upload";

export const runtime = "nodejs";

/**
 * Ouvre (ou reprend) l'envoi en morceaux d'un brouillon : renvoie l'identifiant d'envoi, le
 * découpage et la clé d'ingestion de l'enclave. Voir docs/UPLOAD-1GO.md, §7.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const { chunkBytes } = await readJson<{ chunkBytes?: unknown }>(req);
    return NextResponse.json(await openDatasetUpload(id, session.address, { chunkBytes }), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
