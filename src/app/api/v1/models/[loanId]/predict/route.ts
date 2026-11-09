import { handleApiPredict } from "@/lib/sirius/public-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST https://api.sirius-data.tech/v1/models/<loanId>/predict` (D-30) : prédiction signée sur un
 * modèle loué, requête signée HMAC par la clé API du client (voir src/lib/sirius/public-api.ts).
 */
export async function POST(req: Request, { params }: { params: Promise<{ loanId: string }> }) {
  const { loanId } = await params;
  return handleApiPredict(req, loanId);
}
