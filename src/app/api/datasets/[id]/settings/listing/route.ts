import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireMutationGrant } from "@/lib/auth/mutation-grant";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import {
  applyExtension,
  applyVisibility,
  loadOwnedDataset,
  parseListingRequest,
  readOwnerView,
  visibilityTransition,
} from "@/lib/datasets/manage";

export const runtime = "nodejs";

const NO_STORE = { "cache-control": "private, no-store" };
const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 20, maxGlobal: 400 });

// Un grant de mutation (délégation + signature P-256) tient sous 4 Ko ; marge confortable.
const MAX_LISTING_BODY_BYTES = 16 * 1024;

/**
 * Publication d'une annonce par son propriétaire :
 * - `pause` (LISTED → UNLISTED) et `resume` (UNLISTED ou PRIVATE → LISTED) exigent le grant
 *   de mutation `set-dataset-visibility` de la route de visibilité existante, lié à
 *   l'identifiant et au statut visé, consommé une seule fois ;
 * - `extend` repousse `listingExpiresAt` de 7, 30 ou 90 jours.
 * Chaque transition est vérifiée en lecture puis rejouée par la base au moment d'écrire.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(limiter, `subject:${session.address}`);
    const { id } = await params;
    const request = parseListingRequest(await readJson<Record<string, unknown>>(req, MAX_LISTING_BODY_BYTES));
    const row = await loadOwnedDataset(prisma, id, session.address);
    if (request.action === "extend") {
      await applyExtension(prisma, row, request.days);
    } else {
      const transition = visibilityTransition(request.action, row);
      await requireMutationGrant(session, request.authorization as RunnerGrant, {
        operation: "set-dataset-visibility",
        datasetId: row.id,
        intentParts: [row.id, transition.to],
      });
      await applyVisibility(prisma, row, transition);
    }
    return NextResponse.json(await readOwnerView(prisma, row.id, session.address), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
