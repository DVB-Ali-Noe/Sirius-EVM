import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { readSession } from "@/lib/auth/session";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { reputationsForAddresses } from "@/lib/sirius/reputation";
import { datasetResponse } from "@/lib/sirius/dataset-response";
import { parseCreateDatasetRequest } from "@/lib/datasets/create-request";
import { requireChunkedUploads } from "@/lib/sirius/chunked-upload";
import { createDatasetDraft } from "@/lib/datasets/draft";
import { billingEnabled } from "@/lib/billing/config";
import { publishedTariff } from "@/lib/datasets/tariff-server";
import { requireCurrentEvmDeployment } from "@/lib/evm/deployment";
import { loanRouteErrorResponse } from "@/lib/sirius/availability";

export const runtime = "nodejs";

const PAGE_SIZE = 24;
const CURSOR_RE = /^[A-Za-z0-9_-]{10,64}$/;

function pagedResponse<T>(items: T[], nextCursor: string | null) {
  const response = NextResponse.json(items);
  response.headers.set("cache-control", "no-store");
  if (nextCursor) response.headers.set("x-sirius-next-cursor", nextCursor);
  return response;
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
            {
              status: "DELETED" as const,
              evmDatasetId: { not: null },
              evmDestroyTxHash: null,
              deletionReconciledAt: null,
            },
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
      ...datasetResponse(dataset),
      providerReputation: reputations.get(dataset.provider),
    })), nextCursor);
  }
  return pagedResponse(page.map(datasetResponse), nextCursor);
}

/**
 * Création du brouillon (07-upload.md). Les validations sont toutes refaites côté serveur
 * dans `parseCreateDatasetRequest` : catégorie de la liste fixe, durée de publication parmi
 * 7 / 30 / 90 jours, consentement strictement booléen, prix par jour borné, durée maximale de
 * location (1 à 365 jours), profil connu. Le délai de sécurité de l'escrow n'est pas une entrée :
 * il vaut `ESCROW_CHALLENGE_DAYS` quoi que contienne le corps. La réponse renvoie `maxRentalDays`,
 * signé ensuite dans le reçu du runner (non modifiable après publication). CVM éteinte : après ces
 * contrôles et le KYB, réveil demandé et `503 enclave_starting` sans rien créer (`beginDatasetIngestion`).
 */
export async function POST(req: Request) {
  try {
    const session = requireAuth(req);
    const parsed = parseCreateDatasetRequest(await readJson(req), { v7: billingEnabled(), tariff: publishedTariff() });
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
    // Gros fichier : l'envoi en morceaux doit être disponible avant de créer le brouillon.
    if (parsed.value.transfer === "chunked") requireChunkedUploads(parsed.value.sizeBytes);
    // Avant tout scellement : les contrats doivent être compatibles et accepter le profil au mint.
    await requireCurrentEvmDeployment();
    const upload = await createDatasetDraft(parsed.value, session.address);
    return NextResponse.json(upload, { status: 201 });
  } catch (err) {
    return loanRouteErrorResponse(err);
  }
}
