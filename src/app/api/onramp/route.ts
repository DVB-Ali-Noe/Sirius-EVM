import { NextResponse } from "next/server";
import { buildSignedBuyUrl } from "@/lib/moonpay/url";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";

export const runtime = "nodejs";

/** Renvoie une URL MoonPay signée, liée au wallet authentifié (achat de XRP → auto-activation). */
export async function GET(req: Request) {
  try {
    const session = requireAuth(req);
    const amountParam = new URL(req.url).searchParams.get("amount");
    const amount = amountParam ? Number(amountParam) : undefined;
    const baseCurrencyAmount = amount && Number.isFinite(amount) && amount > 0 ? amount : undefined;

    const url = buildSignedBuyUrl({ walletAddress: session.address, baseCurrencyAmount });
    return NextResponse.json({ url });
  } catch (err) {
    return errorResponse(err);
  }
}
