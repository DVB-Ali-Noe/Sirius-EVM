import "server-only";
import { deriveAddress, verify } from "ripple-keypairs";
import { AppError } from "@/lib/errors";

interface Input {
  address: string;
  publicKey: string;
  signature: string;
  /** String de challenge exacte renvoyée par /api/auth/challenge. */
  message: string;
}

/**
 * Prouve la possession de `address` : (1) l'adresse dérive bien de `publicKey`,
 * (2) `signature` couvre le challenge (encodé en hex, comme le fait ripple-keypairs.sign).
 */
export function verifyWalletSignature({ address, publicKey, signature, message }: Input): void {
  let derived: string;
  try {
    derived = deriveAddress(publicKey);
  } catch {
    throw new AppError("Signature invalide", 401);
  }
  if (derived !== address) throw new AppError("Signature invalide", 401);

  const messageHex = Buffer.from(message, "utf8").toString("hex");
  let ok = false;
  try {
    ok = verify(messageHex, signature, publicKey);
  } catch {
    throw new AppError("Signature invalide", 401);
  }
  if (!ok) throw new AppError("Signature invalide", 401);
}
