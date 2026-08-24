import { NextResponse } from "next/server";
import { verifyChallenge } from "@/lib/auth/challenge";
import { authenticationOrigin } from "@/lib/auth/origin";
import { verifyWalletSignature } from "@/lib/auth/verify-signature";
import { setSession, type SessionSource } from "@/lib/auth/session";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";

export const runtime = "nodejs";

const SOURCES: SessionSource[] = ["external", "embedded"];

export async function POST(req: Request) {
  try {
    const origin = authenticationOrigin(req);
    const { address, publicKey, signature, message, source } = await readJson<Record<string, unknown>>(req);

    if ([address, publicKey, signature, message].some((v) => typeof v !== "string" || !v)) {
      return NextResponse.json({ error: "Requête incomplète" }, { status: 400 });
    }
    if (typeof source !== "string" || !SOURCES.includes(source as SessionSource)) {
      return NextResponse.json({ error: "Source invalide" }, { status: 400 });
    }
    const authenticatedSource = source as SessionSource;
    const authenticatedAddress = address as string;
    const authenticatedPublicKey = publicKey as string;
    const authenticatedSignature = signature as string;
    const authenticatedMessage = message as string;

    // Le challenge lie la string signée à `address` (HMAC + non-expiré) ; la
    // signature prouve la possession de la clé. Les deux échouent en 401.
    await verifyChallenge(authenticatedMessage, authenticatedAddress, origin);
    verifyWalletSignature({
      address: authenticatedAddress,
      publicKey: authenticatedPublicKey,
      signature: authenticatedSignature,
      message: authenticatedMessage,
    });

    const res = NextResponse.json({ address: authenticatedAddress, source: authenticatedSource });
    setSession(res, { address: authenticatedAddress, source: authenticatedSource });
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
