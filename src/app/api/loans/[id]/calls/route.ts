import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { assertAuthenticGrant, assertOwner, requireAuth } from "@/lib/auth/require-auth";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import { isCallPackSize } from "@/lib/billing/api-pricing";
import { RunnerFinalityPending } from "@/lib/runner/failure-policy";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { API_ACCESS_PENDING, CALLS_PENDING } from "@/lib/loans/settlement-status";
import { loanRouteErrorResponse, requireRunnerOrWake } from "@/lib/sirius/availability";
import { prepareApiAccessPass, prepareCallPack, settleLoanPack } from "@/lib/sirius/calls";

export const runtime = "nodejs";

// Mêmes bornes que la préparation et le règlement d'une prolongation.
const preparationLimiter = new FixedWindowRateLimiter({ windowMs: 600_000, maxPerKey: 10, maxGlobal: 600 });
const settlementLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 10, maxGlobal: 100 });

/**
 * Achat rattaché au prêt loué `id`, par son emprunteur, en deux temps :
 * - `{ size }` (100, 1 000 ou 10 000) : prépare un pack d'appels API (D-30) ; `{ apiAccess: true }` :
 *   prépare un pass d'accès API payé au jour jusqu'à l'échéance (D-32). Dans les deux cas un prêt
 *   rattaché (`packForLoanId` = `id`), même flux de lock qu'une prolongation (approbation,
 *   `/authorize`, lock, `/submit` sur le prêt renvoyé) ;
 * - `{ packLoanId, authorization }` : une fois ce lock confirmé, demande au runner le `release` puis
 *   le crédit des appels ou l'enregistrement du pass (`buy-calls`, grant `{ loanId: packLoanId }`).
 *   Rejouable : un achat n'est appliqué qu'une fois.
 * Refusé pour un autre compte, la régression linéaire, un profil sans API et une location échue ;
 * un pass aussi sans tarif d'accès API, location déjà couverte ou pass déjà en paiement.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const body = await readJson<{ size?: unknown; apiAccess?: unknown; packLoanId?: unknown; authorization?: RunnerGrant }>(req);

    if (body.packLoanId === undefined) {
      enforceRateLimit(preparationLimiter, `subject:${session.address}`);
      if (body.apiAccess !== undefined && (body.apiAccess !== true || body.size !== undefined)) {
        return NextResponse.json({ error: "Achat d’accès API invalide" }, { status: 400 });
      }
      if (body.apiAccess === undefined && !isCallPackSize(body.size)) return NextResponse.json({ error: "Taille de pack d’appels invalide" }, { status: 400 });
      const { loan, approveTransaction, lockTransaction, billingQuote } = body.apiAccess === true
        ? await prepareApiAccessPass(id, session.address)
        : await prepareCallPack(id, session.address, body.size as Parameters<typeof prepareCallPack>[2]);
      return NextResponse.json({ loanId: loan.id, approveTransaction, lockTransaction, billingQuote }, { status: 201 });
    }

    enforceRateLimit(settlementLimiter, `subject:${session.address}`);
    if (typeof body.packLoanId !== "string" || !body.packLoanId) return NextResponse.json({ error: "Pack d’appels manquant" }, { status: 400 });
    if (!body.authorization) return NextResponse.json({ error: "Autorisation manquante" }, { status: 400 });
    await assertAuthenticGrant(session, body.authorization);
    const pack = await prisma.loan.findUnique({
      where: { id: body.packLoanId },
      select: {
        borrower: true, packForLoanId: true, apiAccessDays: true, status: true, settleTxHash: true,
        apiAccessRefusedAt: true, evmLoanKey: true, evmLockTxHash: true, evmLockBlock: true,
      },
    });
    if (!pack || pack.packForLoanId !== id) return NextResponse.json({ error: "Pack d’appels introuvable" }, { status: 404 });
    assertOwner(session, pack.borrower);
    // Mêmes contrôles en lecture seule que `settleLoanPack`, avant tout réveil (audit E F1) : un
    // achat déjà réglé ou refusé pour toujours se répond sans le runner, un achat sans lock
    // (devis annulé, jamais payé) est refusé. Seul un lock en attente de règlement réveille la CVM,
    // au budget de l'emprunteur ; le reaper l'appliquera sinon une fois l'enclave allumée.
    const answeredWithoutRunner = Boolean(pack.apiAccessRefusedAt) || (pack.status === "SETTLED" && Boolean(pack.settleTxHash));
    if (!answeredWithoutRunner) {
      if ((pack.status !== "ESCROWED" && pack.status !== "SETTLING") || !pack.evmLoanKey || !pack.evmLockTxHash || !pack.evmLockBlock) {
        return NextResponse.json({ error: "Pack d’appels non verrouillé ou déjà clos" }, { status: 409 });
      }
      await requireRunnerOrWake({ wakeSubject: session.address });
    }
    try {
      return NextResponse.json(await settleLoanPack(body.packLoanId, body.authorization));
    } catch (err) {
      if (err instanceof RunnerFinalityPending) {
        const error = pack.apiAccessDays === null ? CALLS_PENDING : API_ACCESS_PENDING;
        return NextResponse.json({ pending: true, settleTxHash: err.transactionHash, error }, { status: 202 });
      }
      throw err;
    }
  } catch (err) {
    return loanRouteErrorResponse(err);
  }
}
