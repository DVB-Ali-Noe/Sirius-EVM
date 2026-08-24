import "server-only";
import { AppError } from "@/lib/errors";
import { hasAcceptedKyb } from "@/lib/xrpl/credentials";
import { siriusVerifierAddress } from "@/lib/xrpl/verifier";

export async function requireAcceptedKyb(address: string): Promise<void> {
  const issuer = siriusVerifierAddress();
  if (!(await hasAcceptedKyb(address, issuer))) {
    throw new AppError("KYB requis : aucun credential KYB accepté", 403);
  }
}
