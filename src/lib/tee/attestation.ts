import "server-only";
import { createHmac } from "node:crypto";
import { deriveKey, getMasterKey, safeEqual } from "@/lib/crypto/encryption";
import type { Attestation } from "./types";

// L'attestation est un HMAC d'une clé dérivée de la master key. En mode phala cette clé est
// scellée à l'enclave (3d.1) → seul le code mesuré peut signer ; la preuve MATÉRIELLE externe
// est la quote TDX (3d.2). `signer` est un label informationnel (la vérif repose sur le HMAC),
// volontairement DÉCOUPLÉ de la couche provider/DB pour que le cœur runner reste autonome (D-25).
const ATTESTATION_CONTEXT = "attestation-v1";
const ATTESTATION_SIGNER = "sirius-tee";

function sign(payloadHash: string): string {
  const key = deriveKey(getMasterKey(), ATTESTATION_CONTEXT);
  return createHmac("sha256", key).update(payloadHash).digest("hex");
}

export function attest(payloadHash: string): Attestation {
  return { signer: ATTESTATION_SIGNER, payloadHash, signature: sign(payloadHash) };
}

export function verifyAttestation(att: Attestation): boolean {
  return safeEqual(Buffer.from(sign(att.payloadHash), "hex"), Buffer.from(att.signature, "hex"));
}
