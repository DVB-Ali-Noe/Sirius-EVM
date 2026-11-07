import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { apiCanonicalString } from "@/lib/billing/api-pricing";

const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Vérification HMAC d'une requête de l'API développeurs (D-30), sans état : HMAC-SHA256 sous les
 * 32 octets bruts du secret, sur `apiCanonicalString` (corps brut haché en SHA-256), comparé à
 * temps constant à la signature hexadécimale minuscule du client. Horodatage, nonce et clé sont
 * jugés par le runner (`api-predict`, `api-info`).
 */
export function verifyApiSignature(input: {
  secret: Uint8Array;
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body: string;
  signature: string;
}): boolean {
  if (!SIGNATURE_PATTERN.test(input.signature) || !Number.isSafeInteger(input.timestamp)) return false;
  const canonical = apiCanonicalString({
    method: input.method, path: input.path, timestamp: input.timestamp, nonce: input.nonce,
    bodySha256Hex: createHash("sha256").update(input.body).digest("hex"),
  });
  return timingSafeEqual(createHmac("sha256", input.secret).update(canonical).digest(), Buffer.from(input.signature, "hex"));
}
