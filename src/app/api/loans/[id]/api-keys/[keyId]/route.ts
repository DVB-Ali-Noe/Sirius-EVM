import { NextResponse } from "next/server";
import { assertAuthenticGrant, requireAuth } from "@/lib/auth/require-auth";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { parseApiKeyId, revokeLoanApiKey } from "@/lib/sirius/api-keys";
import { loanRouteErrorResponse } from "@/lib/sirius/availability";

export const runtime = "nodejs";

const revocationLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 20, maxGlobal: 600 });

/**
 * Révocation de la clé `keyId` du prêt `id` (D-30) par son emprunteur : `{ authorization }`, grant
 * `revoke-api-key` `{ loanId }` sur `[loanId, keyId]`. Idempotente ; `{ keyId, revokedAt }`.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; keyId: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(revocationLimiter, `subject:${session.address}`);
    const { id, keyId } = await params;
    const { authorization } = await readJson<{ authorization?: RunnerGrant }>(req);
    if (!authorization || typeof authorization !== "object") return NextResponse.json({ error: "Autorisation manquante" }, { status: 400 });
    await assertAuthenticGrant(session, authorization);
    return NextResponse.json(await revokeLoanApiKey({ loanId: id, borrower: session.address, keyId: parseApiKeyId(keyId), authorization }));
  } catch (err) {
    return loanRouteErrorResponse(err);
  }
}
