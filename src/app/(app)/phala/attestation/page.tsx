import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { AttestationBusy, AttestationUnavailable, AttestationView } from "@/components/phala-demo/AttestationView";
import { attestationLimiter, readDemoAttestation } from "@/lib/phala-demo/attestation";
import { requestClientKey } from "@/lib/http/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Runner attestation — Sirius × Phala", robots: { index: false, follow: false } };

export default async function PhalaAttestationPage() {
  if (process.env.SIRIUS_PHALA_DEMO !== "true") notFound();
  let key: string | null;
  try {
    key = requestClientKey(new Request("https://sirius.invalid/phala/attestation", { headers: await headers() }));
  } catch {
    return <AttestationBusy />;
  }
  if (!attestationLimiter.consume(key)) return <AttestationBusy />;
  const attestation = await readDemoAttestation();
  if (!attestation) return <AttestationUnavailable />;
  const { evidence, release } = attestation;
  return (
    <AttestationView
      checkedAt={attestation.checkedAt}
      quoteBytes={evidence.quote.length / 2}
      mrTd={attestation.mrTd}
      composeHash={evidence.composeHash.toLowerCase()}
      release={release}
      certificateSha256={evidence.certificateSha256.toLowerCase()}
      ingressKeySha256={evidence.ingressKeySha256.toLowerCase()}
      masterKeyChainSha256={evidence.masterKeyChainSha256.toLowerCase()}
      settlementAddress={evidence.settlementAddress}
    />
  );
}
