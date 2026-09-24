import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { prepareLoan } from "@/lib/sirius/borrower";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { loanBillingQuote } from "@/lib/billing/loan";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const session = requireAuth(req);
    // N'expose que les prêts où le compte est partie prenante (borrower ou provider).
    const loans = await prisma.loan.findMany({
      where: { OR: [{ borrower: session.address }, { provider: session.address }] },
      orderBy: { createdAt: "desc" },
      include: { dataset: { select: { name: true, runnerReceipt: true } } },
    });
    const now = Date.now();
    return NextResponse.json(loans.map((loan) => ({
      ...loan,
      usdcDecimals: loanBillingQuote(loan)?.quote.usdcDecimals,
      refundable:
        (loan.status === "ESCROWED" || loan.status === "TRAINING" || loan.status === "SETTLING") &&
        loan.evmDeadline !== null &&
        loan.evmDeadline.getTime() <= now,
    })));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const session = requireAuth(req);
    const { datasetId } = await readJson<Record<string, unknown>>(req);

    if (typeof datasetId !== "string" || !datasetId) {
      return NextResponse.json({ error: "datasetId manquant" }, { status: 400 });
    }
    const { loan, approveTransaction, lockTransaction, billingQuote } = await prepareLoan(datasetId, session.address);

    return NextResponse.json({ loanId: loan.id, approveTransaction, lockTransaction, billingQuote }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
