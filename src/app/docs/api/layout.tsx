import type { Metadata } from "next";

// Le page.tsx de l'API est un client component (onglets, copie) → métadonnées portées ici.
export const metadata: Metadata = {
  title: "Developer API — Sirius",
  description:
    "Call the model you rent on Sirius from your code: HMAC-signed requests, predictions signed by the enclave, daily quota and prepaid call packs.",
};

export default function ApiDocsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
