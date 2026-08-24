import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  deleteDataset,
  prepareDatasetMptDestruction,
  setDatasetVisibility,
} from "@/lib/sirius/provider";
import { requireAuth, assertOwner } from "@/lib/auth/require-auth";
import { readSession } from "@/lib/auth/session";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { publicDatasetMetrics } from "@/lib/sirius/metrics";
import { requireMutationGrant } from "@/lib/auth/mutation-grant";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";

export const runtime = "nodejs";

function withoutWrappedKey<T extends { wrappedKey: unknown; metrics: unknown }>(dataset: T) {
  const publicDataset = { ...dataset };
  Reflect.deleteProperty(publicDataset, "wrappedKey");
  return {
    ...publicDataset,
    metrics: publicDatasetMetrics(dataset.metrics),
  } as Omit<T, "wrappedKey">;
}

/**
 * Détail d'un dataset. Public/Semi-privé accessibles à tous (le Semi-privé = par lien
 * direct, hors catalogue) ; Privé/Draft/Suspendu réservés au provider ; Supprimé → 404.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dataset = await prisma.dataset.findUnique({ where: { id } });
  if (!dataset || dataset.status === "DELETED") {
    return NextResponse.json({ error: "Dataset introuvable" }, { status: 404 });
  }

  const publiclyVisible = dataset.status === "LISTED" || dataset.status === "UNLISTED";
  if (!publiclyVisible) {
    const session = readSession(req);
    // 404 (pas 403) pour ne pas révéler l'existence d'un dataset privé à un tiers.
    if (session?.address !== dataset.provider) {
      return NextResponse.json({ error: "Dataset introuvable" }, { status: 404 });
    }
  }
  const session = readSession(req);
  return NextResponse.json(publiclyVisible && session?.address !== dataset.provider ? withoutWrappedKey(dataset) : dataset);
}

/** Change la visibilité (Public / Semi-privé / Privé) — provider uniquement. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const { visibility, authorization } = await readJson<{
      visibility?: unknown;
      authorization?: RunnerGrant;
    }>(req);
    if (typeof visibility !== "string") return NextResponse.json({ error: "Visibilité invalide" }, { status: 400 });
    if (!authorization) return NextResponse.json({ error: "Confirmation wallet requise" }, { status: 400 });
    const owned = await prisma.dataset.findUnique({ where: { id }, select: { provider: true } });
    if (!owned) return NextResponse.json({ error: "Dataset introuvable" }, { status: 404 });
    assertOwner(session, owned.provider);
    await requireMutationGrant(session, authorization, {
      operation: "set-dataset-visibility",
      datasetId: id,
      intentParts: [id, visibility],
    });
    const dataset = await setDatasetVisibility(id, session.address, visibility as "LISTED" | "UNLISTED" | "PRIVATE");
    return NextResponse.json(dataset);
  } catch (err) {
    return errorResponse(err);
  }
}

/** Prépare la destruction MPT à signer par le provider avant le crypto-shredding. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const owned = await prisma.dataset.findUnique({ where: { id }, select: { provider: true } });
    if (!owned) return NextResponse.json({ error: "Dataset introuvable" }, { status: 404 });
    assertOwner(session, owned.provider);
    const transaction = await prepareDatasetMptDestruction(id, session.address);
    return NextResponse.json({ transaction });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Suppression par crypto-shredding : détruit la clé + dépinne + détruit le MPT (D-21). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const { txBlob, authorization } = await readJson<{
      txBlob?: unknown;
      authorization?: RunnerGrant;
    }>(req);
    if (txBlob !== undefined && typeof txBlob !== "string") {
      return NextResponse.json({ error: "Transaction MPT invalide" }, { status: 400 });
    }
    if (!authorization) return NextResponse.json({ error: "Confirmation wallet requise" }, { status: 400 });
    const owned = await prisma.dataset.findUnique({ where: { id }, select: { provider: true } });
    if (!owned) return NextResponse.json({ error: "Dataset introuvable" }, { status: 404 });
    assertOwner(session, owned.provider);
    await requireMutationGrant(session, authorization, {
      operation: "delete-dataset",
      datasetId: id,
      intentParts: [id, txBlob ?? ""],
    });
    const dataset = await deleteDataset(id, session.address, txBlob);
    return NextResponse.json(dataset);
  } catch (err) {
    return errorResponse(err);
  }
}
