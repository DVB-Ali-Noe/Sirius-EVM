import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { beginDatasetIngestion } from "@/lib/sirius/pipeline";
import { requireAuth } from "@/lib/auth/require-auth";
import { readSession } from "@/lib/auth/session";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { MAX_DATASET_BYTES } from "@/lib/tee/contract";
import { priceUsdcToAtomic } from "@/lib/evm/usdc";
import { reputationsForAddresses } from "@/lib/sirius/reputation";
import { publicDatasetMetrics } from "@/lib/sirius/metrics";

export const runtime = "nodejs";

const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MIN_CHALLENGE_DAYS = 1;
const MAX_CHALLENGE_DAYS = 30;
const PAGE_SIZE = 24;
const CURSOR_RE = /^[A-Za-z0-9_-]{10,64}$/;

function pagedResponse<T>(items: T[], nextCursor: string | null) {
  const response = NextResponse.json(items);
  response.headers.set("cache-control", "no-store");
  if (nextCursor) response.headers.set("x-sirius-next-cursor", nextCursor);
  return response;
}

function withoutWrappedKey<T extends { wrappedKey: unknown; metrics: unknown }>(dataset: T) {
  const publicDataset = { ...dataset };
  Reflect.deleteProperty(publicDataset, "wrappedKey");
  return {
    ...publicDataset,
    metrics: publicDatasetMetrics(dataset.metrics),
  } as Omit<T, "wrappedKey">;
}

export async function GET(req: Request) {
  // Le catalogue était la seule route à laisser filer une exception sans la
  // rattraper : Next renvoyait alors un 500 au corps vide. Une panne de base s'y
  // manifestait donc par un écran d'erreur générique, sans rien à lire ni dans le
  // navigateur ni depuis l'extérieur — alors que c'est justement la seule route
  // publique qui interroge la base sans authentification, donc la première à
  // révéler ce genre de panne.
  try {
    return await listerDatasets(req);
  } catch (error) {
    return errorResponse(error);
  }
}

async function listerDatasets(req: Request) {
  // Whitelist : par défaut la marketplace publique n'expose que les LISTED (« Public » ;
  // jamais DRAFT/SUSPENDED/UNLISTED/PRIVATE). Un provider authentifié voit en plus ses
  // propres datasets (hors supprimés = bruit).
  const searchParams = new URL(req.url).searchParams;
  const status = searchParams.get("status");
  const cursor = searchParams.get("cursor");
  if (cursor && !CURSOR_RE.test(cursor)) {
    return NextResponse.json({ error: "Curseur invalide" }, { status: 400 });
  }
  const session = readSession(req);
  const where =
    status === "LISTED" || !session
      ? { status: "LISTED" as const }
      : {
          provider: session.address,
          OR: [
            { status: { not: "DELETED" as const } },
            { status: "DELETED" as const, evmDatasetId: { not: null }, evmDestroyTxHash: null },
          ],
        };
  const datasets = await prisma.dataset.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const page = datasets.slice(0, PAGE_SIZE);
  const nextCursor = datasets.length > PAGE_SIZE ? page.at(-1)?.id ?? null : null;
  if (status === "LISTED" || !session) {
    const reputations = await reputationsForAddresses(page.map((dataset) => dataset.provider), "provider");
    return pagedResponse(page.map((dataset) => ({
      ...withoutWrappedKey(dataset),
      providerReputation: reputations.get(dataset.provider),
    })), nextCursor);
  }
  return pagedResponse(page, nextCursor);
}

export async function POST(req: Request) {
  try {
    const session = requireAuth(req);
    const body = await readJson<{
      name?: unknown;
      description?: unknown;
      sizeBytes?: unknown;
      priceUsdc?: unknown;
      challengeDays?: unknown;
    }>(req);
    if (typeof body.name !== "string" || body.name.trim() === "" || body.name.trim().length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: "Nom manquant" }, { status: 400 });
    }
    if (
      body.description !== undefined &&
      (typeof body.description !== "string" || body.description.length > MAX_DESCRIPTION_LENGTH)
    ) {
      return NextResponse.json({ error: "Description invalide" }, { status: 400 });
    }
    if (
      typeof body.sizeBytes !== "number" ||
      !Number.isSafeInteger(body.sizeBytes) ||
      body.sizeBytes <= 0 ||
      body.sizeBytes > MAX_DATASET_BYTES
    ) {
      return NextResponse.json({ error: "Fichier trop volumineux (max 16 Mo)" }, { status: 413 });
    }
    const priceUsdcAtomic = priceUsdcToAtomic(body.priceUsdc);
    if (!priceUsdcAtomic) {
      return NextResponse.json({ error: "Prix invalide (0.001 à 1 000 000 USDC)" }, { status: 400 });
    }
    const challengeDays = Number(body.challengeDays);
    if (
      !Number.isSafeInteger(challengeDays) ||
      challengeDays < MIN_CHALLENGE_DAYS ||
      challengeDays > MAX_CHALLENGE_DAYS
    ) {
      return NextResponse.json({ error: "Délai invalide (1 à 30 jours)" }, { status: 400 });
    }

    const upload = await beginDatasetIngestion({
      name: body.name.trim(),
      description: body.description?.trim() || undefined,
      provider: session.address,
      sizeBytes: body.sizeBytes,
      priceUsdcAtomic,
      challengeDays,
    });

    return NextResponse.json(upload, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
