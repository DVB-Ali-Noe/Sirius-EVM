import { NextResponse } from "next/server";
import { enforceRateLimit, requestClientKey } from "@/lib/http/rate-limit";
import { attestationLimiter, readDemoAttestation } from "@/lib/phala-demo/attestation";
import { errorResponse } from "@/lib/errors";

export const runtime = "nodejs";

/** Preuve brute à télécharger ; la lecture humaine est la page `/phala/attestation`. */
export async function GET(req: Request) {
  try {
    enforceRateLimit(attestationLimiter, requestClientKey(req));
  } catch (error) {
    return errorResponse(error);
  }
  const attestation = await readDemoAttestation();
  if (!attestation) return NextResponse.json({ error: "Attestation indisponible : le runner doit être actif" }, { status: 503 });
  return NextResponse.json({ verifiedAt: attestation.checkedAt, evidence: attestation.evidence }, {
    headers: { "cache-control": "no-store", "content-disposition": 'attachment; filename="sirius-phala-attestation.json"' },
  });
}
