import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { prepareLoan } from "@/lib/sirius/borrower";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { loanBillingQuote } from "@/lib/billing/loan";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import { isValidRentalDays } from "@/lib/billing/rental";
import { loanApiCallsPerDay } from "@/lib/sirius/api-keys";
import { loanRouteErrorResponse } from "@/lib/sirius/availability";

export const runtime = "nodejs";

// Chaque préparation fait signer un devis au runner et remplace le PENDING non payé du compte, dont
// l'autorisation de lock reste valable jusqu'à neuf minutes : dix préparations par compte et par
// dix minutes bornent ce que des préparations abandonnées peuvent encore verrouiller (audit A-06).
const preparationLimiter = new FixedWindowRateLimiter({ windowMs: 600_000, maxPerKey: 10, maxGlobal: 600 });

export async function GET(req: Request) {
  try {
    const session = requireAuth(req);
    // N'expose que les prêts où le compte est partie prenante (borrower ou provider). Les colonnes de
    // location (`rentalDays`, `rentalExpiresAt`, `extendsLoanId`), de pack d'appels (`callPack`,
    // `packForLoanId`, D-30) et de pass d'accès API (`apiAccessDays`, `apiPaidUntil`, D-32) partent
    // telles quelles ; le prix par jour et la durée maximale du dataset
    // servent au choix des jours d'une prolongation et au prix des packs. Pour un prêt d'origine,
    // `apiEnabled` et `callsPerDay` disent si son profil a une API (quota quotidien inclus).
    const loans = await prisma.loan.findMany({
      where: { OR: [{ borrower: session.address }, { provider: session.address }] },
      orderBy: { createdAt: "desc" },
      include: { dataset: { select: { name: true, runnerReceipt: true, maxRentalDays: true, priceUsdcAtomic: true } } },
    });
    const now = Date.now();
    const callsPerDayByModel = new Map<string, number | null>();
    const callsPerDayFor = (modelId: string) => {
      if (!callsPerDayByModel.has(modelId)) callsPerDayByModel.set(modelId, loanApiCallsPerDay(modelId));
      return callsPerDayByModel.get(modelId) ?? null;
    };
    return NextResponse.json(loans.map((loan) => {
      const origin = !loan.extendsLoanId && !loan.packForLoanId;
      const callsPerDay = origin ? callsPerDayFor(loan.modelId) : null;
      return {
        ...loan,
        usdcDecimals: loanBillingQuote(loan)?.quote.usdcDecimals,
        apiEnabled: callsPerDay !== null,
        callsPerDay,
        refundable:
          (loan.status === "ESCROWED" || loan.status === "TRAINING" || loan.status === "SETTLING") &&
          loan.evmDeadline !== null &&
          loan.evmDeadline.getTime() <= now,
      };
    }));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(preparationLimiter, `subject:${session.address}`);
    const { datasetId, rentalDays, includeApiAccess } = await readJson<Record<string, unknown>>(req);

    if (typeof datasetId !== "string" || !datasetId) {
      return NextResponse.json({ error: "datasetId manquant" }, { status: 400 });
    }
    // Bornée ici à 1–365, puis par `maxRentalDays` du dataset dans `prepareLoan`.
    if (!isValidRentalDays(rentalDays)) {
      return NextResponse.json({ error: "Durée de location invalide" }, { status: 400 });
    }
    if (includeApiAccess !== undefined && typeof includeApiAccess !== "boolean") {
      return NextResponse.json({ error: "Accès API inclus du devis invalide" }, { status: 400 });
    }
    // `includeApiAccess` (D-32) : l'API est incluse dans le devis, jours × tarif journalier de l'API.
    const { loan, approveTransaction, lockTransaction, billingQuote } = await prepareLoan(datasetId, session.address, rentalDays, undefined,
      { includeApiAccess: includeApiAccess === true });

    return NextResponse.json({ loanId: loan.id, approveTransaction, lockTransaction, billingQuote }, { status: 201 });
  } catch (err) {
    return loanRouteErrorResponse(err);
  }
}
