import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { AttestationUnavailable, AttestationView } from "@/components/phala-demo/AttestationView";
import { attestationLimiter, readDemoAttestation } from "@/lib/phala-demo/attestation";
import { requestClientKey } from "@/lib/http/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Runner attestation — Sirius × Phala", robots: { index: false, follow: false } };

const HEX = /^[0-9a-f]{96}$/i;

export default async function PhalaAttestationPage() {
  if (process.env.SIRIUS_PHALA_DEMO !== "true") notFound();
  const key = requestClientKey(new Request("https://sirius.invalid/phala/attestation", { headers: await headers() }));
  const attestation = attestationLimiter.consume(key) ? await readDemoAttestation() : null;
  if (!attestation) return <AttestationUnavailable />;
  const { evidence } = attestation;
  // Le transport n'est ouvert qu'avec un MRTD égal à la valeur épinglée : c'est celle affichée.
  const pinnedMrtd = process.env.SIRIUS_EXPECTED_MRTD?.trim().toLowerCase() ?? "";
  return (
    <AttestationView
      checkedAt={attestation.checkedAt}
      mrtd={HEX.test(pinnedMrtd) ? pinnedMrtd : null}
      composeHash={evidence.composeHash.toLowerCase()}
      certificateSha256={evidence.certificateSha256.toLowerCase()}
      ingressKeySha256={evidence.ingressKeySha256.toLowerCase()}
      masterKeyChainSha256={evidence.masterKeyChainSha256.toLowerCase()}
      settlementAddress={evidence.settlementAddress}
      quoteBytes={evidence.quote.length / 2}
    />
  );
}
