import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { prisma } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { resolveServerNetwork } from "@/lib/xrpl/networks";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const session = requireAuth(req);
    const loans = await prisma.loan.findMany({
      where: { OR: [{ borrower: session.address }, { provider: session.address }] },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        borrower: true,
        provider: true,
        amount: true,
        currency: true,
        status: true,
        escrowTxHash: true,
        settleTxHash: true,
        auditTxHash: true,
        cancelTxHash: true,
        attestationHash: true,
        attestationComposeHash: true,
        cancelAfter: true,
        createdAt: true,
        settledAt: true,
        dataset: {
          select: { name: true, mptIssuanceId: true, mptTxHash: true },
        },
      },
    });
    return NextResponse.json({ network: resolveServerNetwork().network, loans });
  } catch (error) {
    return errorResponse(error);
  }
}
