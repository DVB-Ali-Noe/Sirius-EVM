import { NextResponse } from "next/server";
import { buildSignedBuyUrl } from "@/lib/moonpay/url";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";

export const runtime = "nodejs";

/**
 * Pont officiel vers Robinhood Chain. MoonPay livre l'USDC sur Ethereum, pas sur
 * Robinhood Chain : sur mainnet, l'utilisateur paierait avec de l'argent réel des
 * fonds arrivant sur la mauvaise chaîne. On l'oriente donc vers le pont.
 */
const BRIDGE_URL = "https://app.across.to/bridge";

/** Renvoie une URL MoonPay signée liée au wallet authentifié, ou le pont sur mainnet. */
export async function GET(req: Request) {
  try {
    const session = requireAuth(req);
    if (process.env.EVM_NETWORK?.trim() === "mainnet") return NextResponse.json({ url: BRIDGE_URL, kind: "bridge" });
    const amountParam = new URL(req.url).searchParams.get("amount");
    const amount = amountParam ? Number(amountParam) : undefined;
    const baseCurrencyAmount = amount && Number.isFinite(amount) && amount > 0 ? amount : undefined;

    const url = buildSignedBuyUrl({ walletAddress: session.address, baseCurrencyAmount });
    return NextResponse.json({ url, kind: "buy" });
  } catch (err) {
    return errorResponse(err);
  }
}
