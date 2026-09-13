import { NextResponse } from "next/server";
import { renewLoanLock } from "@/lib/sirius/borrower";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    return NextResponse.json(await renewLoanLock(id, session.address));
  } catch (error) {
    return errorResponse(error);
  }
}
