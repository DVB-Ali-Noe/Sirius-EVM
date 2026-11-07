import { NextResponse } from "next/server";
import { assertAuthenticGrant, requireAuth } from "@/lib/auth/require-auth";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import {
  listLoanApiKeys,
  parseApiKeyEnvelope,
  parseApiKeyId,
  parseApiKeyName,
  prepareLoanApiKey,
  registerLoanApiKey,
} from "@/lib/sirius/api-keys";
import { loanRouteErrorResponse } from "@/lib/sirius/availability";

export const runtime = "nodejs";

const listLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 60, maxGlobal: 1_200 });
const creationLimiter = new FixedWindowRateLimiter({ windowMs: 600_000, maxPerKey: 20, maxGlobal: 600 });

/** Clés API du prêt `id` (D-30), pour son emprunteur : sans secret, avec les appels des 30 derniers jours. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(listLimiter, `subject:${session.address}`);
    const { id } = await params;
    return NextResponse.json(await listLoanApiKeys(id, session.address), { headers: { "cache-control": "private, no-store" } });
  } catch (err) {
    return loanRouteErrorResponse(err);
  }
}

/**
 * Création d'une clé API, en deux temps :
 * - `{}` : contrôles d'accès, réveil de la CVM si besoin (503 `enclave_starting`), puis
 *   `{ ingressKey }` pour que le navigateur chiffre le secret pour l'enclave ;
 * - `{ keyId, name, envelope, authorization }` : scellement dans l'enclave (`register-api-key`,
 *   grant `{ loanId }` sur `[loanId, keyId, sha256(enveloppe)]`), puis `{ keyId, name, createdAt }`.
 * Refusée à un autre compte, pour la régression linéaire et sur une location échue.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(creationLimiter, `subject:${session.address}`);
    const { id } = await params;
    const body = await readJson<{ keyId?: unknown; name?: unknown; envelope?: unknown; authorization?: RunnerGrant }>(req);
    if (body.envelope === undefined) return NextResponse.json(await prepareLoanApiKey(id, session.address));
    const keyId = parseApiKeyId(body.keyId);
    const name = parseApiKeyName(body.name);
    const envelope = parseApiKeyEnvelope(body.envelope);
    if (!body.authorization || typeof body.authorization !== "object") return NextResponse.json({ error: "Autorisation manquante" }, { status: 400 });
    await assertAuthenticGrant(session, body.authorization);
    const key = await registerLoanApiKey({ loanId: id, borrower: session.address, keyId, name, envelope, authorization: body.authorization });
    return NextResponse.json(key, { status: 201 });
  } catch (err) {
    return loanRouteErrorResponse(err);
  }
}
