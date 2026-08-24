import { NextResponse } from "next/server";
import { decode, isValidClassicAddress } from "xrpl";
import { buildPayment, submitSignedPayment } from "@/lib/xrpl/payment";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";

export const runtime = "nodejs";

function parseAmount(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0.000001 || n > 100_000_000) {
    throw new Error("Montant invalide");
  }
  return n;
}

/**
 * Phase 1 — prépare un `Payment` autofillé (non signé) depuis le wallet authentifié
 * vers une adresse choisie. Sortie de secours non-custodial (D-20).
 */
export async function POST(req: Request) {
  try {
    const session = requireAuth(req);
    const { destination, amountXrp } = await readJson<Record<string, unknown>>(req);

    if (typeof destination !== "string" || !isValidClassicAddress(destination)) {
      return NextResponse.json({ error: "Adresse de destination invalide" }, { status: 400 });
    }
    if (destination === session.address) {
      return NextResponse.json({ error: "Destination identique à l'expéditeur" }, { status: 400 });
    }

    let amount: number;
    try {
      amount = parseAmount(amountXrp);
    } catch {
      return NextResponse.json({ error: "Montant invalide" }, { status: 400 });
    }

    const transaction = await buildPayment(session.address, destination, String(amount));
    return NextResponse.json({ transaction });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Phase 2 — soumet le `Payment` signé. Vérifie que l'`Account` correspond bien au
 * compte authentifié (pas de relais de blob arbitraire) ; le ledger garantit la signature.
 */
export async function PUT(req: Request) {
  try {
    const session = requireAuth(req);
    const { txBlob } = await readJson<{ txBlob?: unknown }>(req);
    if (typeof txBlob !== "string") {
      return NextResponse.json({ error: "Transaction manquante" }, { status: 400 });
    }

    let decoded: Record<string, unknown>;
    try {
      decoded = decode(txBlob) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Transaction signée illisible" }, { status: 400 });
    }
    if (decoded.TransactionType !== "Payment" || decoded.Account !== session.address) {
      return NextResponse.json({ error: "Transaction non conforme au compte" }, { status: 400 });
    }

    const txHash = await submitSignedPayment(txBlob);
    return NextResponse.json({ txHash });
  } catch (err) {
    return errorResponse(err);
  }
}
