import { NextResponse } from "next/server";
import { finalizeLoan } from "@/lib/sirius/borrower";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";

export const runtime = "nodejs";

/** Phase 2 : reçoit l'EscrowCreate signé par le borrower, le vérifie et le soumet. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const { txBlob } = await readJson<{ txBlob?: unknown }>(req);
    if (txBlob !== undefined && (typeof txBlob !== "string" || !txBlob)) {
      return NextResponse.json({ error: "txBlob invalide" }, { status: 400 });
    }
    // finalizeLoan applique le contrôle de propriété (borrower === session.address).
    const loan = await finalizeLoan(id, session.address, typeof txBlob === "string" ? txBlob : undefined);
    return NextResponse.json(loan);
  } catch (err) {
    return errorResponse(err);
  }
}
