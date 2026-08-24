import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { finalizeKybAcceptance, prepareKybAcceptance } from "@/lib/sirius/kyb";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const session = requireAuth(req);
    return NextResponse.json(await prepareKybAcceptance(session.address));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request) {
  try {
    const session = requireAuth(req);
    const { txBlob } = await readJson<{ txBlob?: unknown }>(req);
    if (txBlob !== undefined && typeof txBlob !== "string") {
      return NextResponse.json({ error: "Transaction CredentialAccept invalide" }, { status: 400 });
    }
    return NextResponse.json(await finalizeKybAcceptance(session.address, txBlob));
  } catch (err) {
    return errorResponse(err);
  }
}
