import { NextResponse } from "next/server";
import { distribuerFondsDeTest, faucetAvailable } from "@/lib/sirius/faucet";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { AppError } from "@/lib/errors";
import { enforceRateLimit, FixedWindowRateLimiter, requestClientKey } from "@/lib/http/rate-limit";

export const runtime = "nodejs";

/**
 * Le rationnement compte autant que la distribution : la réserve d'ETH est finie et
 * un seul visiteur en boucle la viderait pour tous les autres. Une demande par heure
 * et par compte suffit largement — mille USDC couvrent des centaines d'emprunts.
 */
const faucetLimiter = new FixedWindowRateLimiter({
  windowMs: 60 * 60_000,
  maxPerKey: 1,
  maxGlobal: 120,
});

export async function POST(req: Request) {
  try {
    const session = requireAuth(req);
    if (!faucetAvailable()) {
      throw new AppError("Distribution de fonds de test indisponible sur cette instance", 503);
    }
    // Clé de limitation sur l'adresse de session, pas sur l'IP seule : l'adresse est
    // ce que l'on sert, et elle a été prouvée par signature au moment de la connexion.
    enforceRateLimit(faucetLimiter, requestClientKey(req, session.address));
    return NextResponse.json(await distribuerFondsDeTest(session.address));
  } catch (err) {
    return errorResponse(err);
  }
}
