import type { Metadata } from "next";

// Le page.tsx docs est un client component (useBlobStore) → métadonnées portées ici.
export const metadata: Metadata = {
  title: "Documentation — Sirius",
  description:
    "Comment fonctionne Sirius : data lending confidentiel sur XRPL, entraînement en TEE, fair-exchange atomique et audit on-chain.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
