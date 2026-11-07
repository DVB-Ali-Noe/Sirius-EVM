import { handleApiInfo } from "@/lib/sirius/public-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET https://api.sirius-data.tech/v1/models/<loanId>` (D-30) : profil, variables attendues,
 * échéance et appels restants du modèle loué, sans consommer de quota. Même signature HMAC.
 */
export async function GET(req: Request, { params }: { params: Promise<{ loanId: string }> }) {
  const { loanId } = await params;
  return handleApiInfo(req, loanId);
}
