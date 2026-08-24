import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { finalizeDatasetListing, prepareDatasetListing } from "@/lib/sirius/provider";
import { requireAuth, assertOwner } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const owned = await prisma.dataset.findUnique({ where: { id }, select: { provider: true } });
    if (!owned) return NextResponse.json({ error: "Dataset introuvable" }, { status: 404 });
    assertOwner(session, owned.provider);
    const transaction = await prepareDatasetListing(id, session.address);
    return NextResponse.json({ transaction });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const { txBlob } = await readJson<{ txBlob?: unknown }>(req);
    if (txBlob !== undefined && typeof txBlob !== "string") {
      return NextResponse.json({ error: "Transaction MPT invalide" }, { status: 400 });
    }
    const owned = await prisma.dataset.findUnique({ where: { id }, select: { provider: true } });
    if (!owned) return NextResponse.json({ error: "Dataset introuvable" }, { status: 404 });
    assertOwner(session, owned.provider);
    return NextResponse.json(await finalizeDatasetListing(id, session.address, txBlob));
  } catch (err) {
    return errorResponse(err);
  }
}
