import "server-only";
import { isValidClassicAddress } from "xrpl";
import { getServerWallet } from "./server-wallets";
import { resolveServerNetwork } from "./networks";

export function siriusVerifierAddress(): string {
  const configured = process.env.SIRIUS_VERIFIER_ADDRESS?.trim();
  if (configured) {
    if (!isValidClassicAddress(configured)) throw new Error("SIRIUS_VERIFIER_ADDRESS invalide");
    return configured;
  }
  if (process.env.NODE_ENV === "production" || resolveServerNetwork().network === "mainnet") {
    throw new Error("SIRIUS_VERIFIER_ADDRESS obligatoire hors développement");
  }
  return getServerWallet("verifier").address;
}
