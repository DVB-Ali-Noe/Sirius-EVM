import { NextResponse } from "next/server";
import { enforceRateLimit, requestClientKey } from "@/lib/http/rate-limit";
import { attestationLimiter, readDemoAttestation } from "@/lib/phala-demo/attestation";
import { errorResponse } from "@/lib/errors";

export const runtime = "nodejs";

/**
 * Preuve brute à télécharger ; la lecture humaine est la page `/phala/attestation`.
 * `appCompose` (octets exacts du fichier publié) n'est joint que si son SHA-256 égale le hash attesté.
 */
export async function GET(req: Request) {
  try {
    enforceRateLimit(attestationLimiter, requestClientKey(req));
  } catch (error) {
    return errorResponse(error);
  }
  const attestation = await readDemoAttestation();
  if (!attestation) return NextResponse.json({ error: "Attestation indisponible : le runner doit être actif" }, { status: 503 });
  const { checkedAt, evidence, release } = attestation;
  const appCompose = release.status === "proven" ? { appCompose: release.appCompose } : {};
  return NextResponse.json({ verifiedAt: checkedAt, evidence, ...appCompose }, {
    headers: { "cache-control": "no-store", "content-disposition": 'attachment; filename="sirius-phala-attestation.json"' },
  });
}
