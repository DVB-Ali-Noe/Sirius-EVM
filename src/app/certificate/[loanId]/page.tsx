import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { loadCertificate } from "@/lib/certificate/load";
import { verifyCertificate } from "@/lib/certificate/verification";
import { certificateViewProps } from "@/lib/certificate/display";
import { CertificateUnavailable, CertificateView } from "./certificate-view";

/**
 * Certificat d'exécution public d'un entraînement d'emprunt.
 *
 * Comme `/proof/[id]`, la page est hors du groupe `(app)` : sans session, sans JavaScript
 * nécessaire, rendue côté serveur, pour qu'un lien partagé s'ouvre tel quel. Tout le
 * contrôle d'accès est dans `resolveCertificate` : identifiant inconnu ou dataset fermé →
 * 404 indistinct ; prêt non réglé ou sans attestation cohérente → état « pas encore
 * disponible », sans aucun détail.
 *
 * La vérification de la quote est bornée et mise en cache (`verification.ts`) : la page
 * ne peut pas servir à multiplier les appels à la collatérale Intel.
 */

export const runtime = "nodejs";

type Params = { params: Promise<{ loanId: string }> };

/** Une seule lecture en base par requête, partagée entre les métadonnées et la page. */
const certificateFor = cache(loadCertificate);

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { loanId } = await params;
  const certificate = await certificateFor(loanId);
  // Un lien de certificat se partage ; il n'a pas à être indexé.
  const robots = { index: false, follow: false };
  if (certificate.kind === "not-found") return { title: "Certificate not found", robots };
  if (certificate.kind === "unavailable") return { title: "Certificate not available yet", robots };
  return {
    title: `${certificate.record.dataset.name} — execution certificate`,
    description:
      "Execution certificate of a training run on Sirius: enclave attestation, measurements and on-chain settlement. No account required.",
    robots,
  };
}

export default async function CertificatePage({ params }: Params) {
  const { loanId } = await params;
  const certificate = await certificateFor(loanId);
  if (certificate.kind === "not-found") notFound();
  if (certificate.kind === "unavailable") return <CertificateUnavailable />;

  const outcome = await verifyCertificate(certificate.record);
  const props = certificateViewProps(certificate.record, outcome);
  if (!props) return <CertificateUnavailable />;
  return <CertificateView {...props} />;
}
