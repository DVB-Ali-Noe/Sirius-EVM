import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { verifyTdxQuote } from "@/lib/tee/quote";
import type { QuoteVerification } from "@/lib/tee/quote";
import { AppError, errorResponse } from "@/lib/errors";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";

export const runtime = "nodejs";

const attestationLimiter = new FixedWindowRateLimiter({
  windowMs: 60_000,
  maxPerKey: 10,
  maxGlobal: 100,
});
const ATTESTATION_CACHE_TTL_MS = 10 * 60_000;
const ATTESTATION_CACHE_MAX = 1_000;
const verificationCache = new Map<string, { expiresAt: number; value: QuoteVerification }>();

async function verifyCachedAttestation(
  cacheKey: string,
  quote: string,
  payloadHash: string,
  evidence?: { eventLog: string; composeHash: string },
): Promise<QuoteVerification> {
  const now = Date.now();
  const cached = verificationCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;
  verificationCache.delete(cacheKey);
  if (verificationCache.size >= ATTESTATION_CACHE_MAX) {
    const oldest = verificationCache.keys().next().value;
    if (oldest) verificationCache.delete(oldest);
  }
  const value = await verifyTdxQuote(quote, payloadHash, evidence);
  verificationCache.set(cacheKey, { expiresAt: now + ATTESTATION_CACHE_TTL_MS, value });
  return value;
}

/**
 * Preuve d'exécution confidentielle d'un emprunt réglé : renvoie le hash gravé on-chain et,
 * en mode phala, la quote TDX + sa vérification (binding report_data == modèle + signature
 * Intel). Ouvert aux deux parties (borrower & provider). Le HMAC de release, lui, est vérifié
 * inline au règlement (settle) ; ici on expose la preuve MATÉRIELLE vérifiable indépendamment.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(attestationLimiter, `subject:${session.address}`);
    const { id } = await params;
    const loan = await prisma.loan.findUnique({ where: { id } });
    if (!loan) throw new AppError("Loan introuvable", 404);
    if (session.address !== loan.borrower && session.address !== loan.provider) {
      throw new AppError("Accès refusé : preuve réservée aux parties de l'emprunt", 403);
    }
    if (loan.status !== "SETTLED" || !loan.attestationHash) {
      throw new AppError("Emprunt pas encore réglé", 409);
    }

    if (!loan.attestationQuote) {
      return NextResponse.json({ payloadHash: loan.attestationHash, quote: null, verification: null });
    }

    // La vérif matérielle est sautée d'elle-même au simulateur (cf verifyTdxQuote).
    const evidence =
      loan.attestationEventLog && loan.attestationComposeHash
        ? { eventLog: loan.attestationEventLog, composeHash: loan.attestationComposeHash }
        : undefined;
    const verification = await verifyCachedAttestation(
      `${loan.id}:${loan.attestationHash}`,
      loan.attestationQuote,
      loan.attestationHash,
      evidence,
    );
    return NextResponse.json({
      payloadHash: loan.attestationHash,
      quote: loan.attestationQuote,
      evidence,
      verification,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
