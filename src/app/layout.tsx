import type { Metadata } from "next";
import "./globals.css";
import SharedBlob from "@/components/layout/SharedBlob";
import { WalletConnector } from "@/components/wallet/WalletConnector";
import { LandingRedirect } from "@/components/layout/LandingRedirect";
import { StoreHydrator } from "@/components/layout/StoreHydrator";
import { E2eWalletBridge } from "@/components/testing/E2eWalletBridge";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";

/**
 * Rendu dynamique imposé à toute l'application.
 *
 * proxy.ts pose une politique de sécurité avec un nonce régénéré à chaque requête.
 * Une page prérendue au build ne peut pas la satisfaire : son HTML est figé, ses
 * scripts en ligne ne portent aucun nonce, et chaque réponse en exige un nouveau.
 * Le navigateur rejette alors tout le JavaScript et l'application ne s'hydrate jamais.
 *
 * On perd la mise en cache du HTML au profit d'une politique de sécurité qui tient
 * réellement. L'inverse — assouplir la politique pour garder le cache — reviendrait à
 * autoriser les scripts en ligne, c'est-à-dire à retirer la protection contre
 * l'injection que cette politique existe pour fournir.
 */
export const dynamic = "force-dynamic";

// Rendues côté serveur, donc figées : ce sont elles qu'un moteur de recherche lit et
// qu'un réseau social affiche en aperçu de lien. Le sélecteur de langue n'y change
// rien, et un titre français sur un site anglophone se remarque avant la page.
export const metadata: Metadata = {
  title: "Sirius — confidential data lending on EVM",
  description:
    "Lend valuable datasets without ever exposing them. Training inside a TEE, USDC settlement, and an audit trail on EVM.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <LocaleProvider>
          <SharedBlob />
          <WalletConnector />
          <E2eWalletBridge />
          <StoreHydrator />
          <LandingRedirect />
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}
