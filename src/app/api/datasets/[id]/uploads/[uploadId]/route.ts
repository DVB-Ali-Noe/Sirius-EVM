import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { abortDatasetUpload, datasetUploadStatus } from "@/lib/sirius/chunked-upload";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; uploadId: string }> };

/**
 * État de l'envoi : morceaux déjà reçus (reprise), puis suivi du scellement. Une fois scellé, le
 * brouillon porte sa référence et son reçu, et se publie comme un petit fichier.
 */
export async function GET(req: Request, { params }: Context) {
  try {
    const session = requireAuth(req);
    const { id, uploadId } = await params;
    return NextResponse.json(await datasetUploadStatus(id, uploadId, session.address), {
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Abandon : l'envoi est fermé et ses morceaux supprimés de R2. */
export async function DELETE(req: Request, { params }: Context) {
  try {
    const session = requireAuth(req);
    const { id, uploadId } = await params;
    return NextResponse.json(await abortDatasetUpload(id, uploadId, session.address));
  } catch (err) {
    return errorResponse(err);
  }
}
