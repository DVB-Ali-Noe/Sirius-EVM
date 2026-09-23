import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { loanModelKeyInRunner } from "@/lib/tee/runner-client";
import { readLoan } from "@/lib/evm/escrow";
import { loanEscrowBinding } from "@/lib/evm/history";
import { addressesEqual } from "@/lib/evm/address";
import { assertGrantSubject, requireAuth, assertOwner } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { assertCurrentRunner } from "@/lib/runner/provenance";
import { loanBillingQuote } from "@/lib/billing/loan";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";

export const runtime = "nodejs";

const keyDeliveryLimiter = new FixedWindowRateLimiter({
  windowMs: 60_000,
  maxPerKey: 20,
  maxGlobal: 200,
});

/** Retourne le préimage EVM devenu public pour ouvrir la capsule locale. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(keyDeliveryLimiter, `subject:${session.address}`);
    const { id } = await params;
    const loan = await prisma.loan.findUnique({ where: { id } });
    if (!loan) return NextResponse.json({ error: "Loan introuvable" }, { status: 404 });
    assertOwner(session, loan.borrower);
    if (
      loan.status !== "SETTLED" ||
      !loan.modelCid ||
      !loan.settleTxHash ||
      !loan.evmLoanKey
    ) {
      return NextResponse.json({ error: "Modèle pas encore livré" }, { status: 409 });
    }
    if (loanBillingQuote(loan)) return NextResponse.json({ error: "Livraison par le runner après confirmation" }, { status: 409 });
    const onChain = await readLoan(loan.evmLoanKey as `0x${string}`, loanEscrowBinding(loan));
    if (!onChain || onChain.status !== 2 || !addressesEqual(onChain.borrower, loan.borrower)) {
      return NextResponse.json({ error: "Préimage EVM indisponible" }, { status: 409 });
    }
    return NextResponse.json({
      modelCid: loan.modelCid,
      settleTxHash: loan.settleTxHash,
      preimage: onChain.preimage,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Re-livre la clé du modèle d'un emprunt réglé (la clé est dérivée, jamais stockée). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(keyDeliveryLimiter, `subject:${session.address}`);
    const { id } = await params;
    const { authorization, deliveryPublicKey } = await readJson<{
      authorization?: RunnerGrant;
      deliveryPublicKey?: unknown;
    }>(req);
    if (!authorization || typeof deliveryPublicKey !== "string") {
      return NextResponse.json({ error: "Autorisation ou clé de livraison manquante" }, { status: 400 });
    }
    assertGrantSubject(session, authorization);
    const loan = await prisma.loan.findUnique({ where: { id } });
    if (!loan) return NextResponse.json({ error: "Loan introuvable" }, { status: 404 });
    assertOwner(session, loan.borrower);
    if (loan.status !== "SETTLED" || !loan.modelCid || !loan.runnerReceipt || !loan.settleTxHash) {
      return NextResponse.json({ error: "Modèle pas encore livré" }, { status: 409 });
    }
    await assertCurrentRunner(loan);
    const delivery = await loanModelKeyInRunner(
      id,
      loan.runnerReceipt,
      deliveryPublicKey,
      authorization,
      loan.settleTxHash,
    );
    return NextResponse.json({ modelCid: delivery.modelCid, modelKeyEnvelope: delivery.modelKeyEnvelope });
  } catch (err) {
    return errorResponse(err);
  }
}
