import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { requireAuth } from "@/lib/auth/require-auth";

export function operatorAllowed(address: string, configured = process.env.SIRIUS_DEMO_OPERATORS): boolean {
  const wallets = configured?.split(",").map((value) => value.trim().toLowerCase()) ?? [];
  return wallets.length > 0 && wallets.length <= 10 && wallets.every((value) => /^0x(?!0{40}$)[0-9a-f]{40}$/.test(value))
    && wallets.includes(address.toLowerCase());
}

export function requireDemoOperator(req: Request): string {
  const session = requireAuth(req);
  if (!operatorAllowed(session.address)) throw new AppError("Commande réservée aux opérateurs Sirius", 403);
  return session.address;
}

export function controllerAuthorized(header: string | null, secret = process.env.PHALA_DEMO_CONTROLLER_SECRET): boolean {
  if (!secret || !/^[A-Za-z0-9+/]{43}=$/.test(secret) || !header || header.length > 128) return false;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(header), hash(`Bearer ${secret}`));
}
