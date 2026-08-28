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
const ORIGINE_PAR_DEFAUT = "https://sirius-data.tech";

/**
 * Origine publique du site, pour les aperçus de lien.
 *
 * Elle doit tolérer une valeur illisible. `vercel pull` remplace le contenu des
 * variables marquées « Secret » par la chaîne « [SENSITIVE] » : au moment du build,
 * cette variable ne contient alors pas une URL. Une métadonnée d'aperçu est
 * cosmétique — la laisser interrompre la construction de tout le site serait hors
 * de proportion, et à l'exécution la vraie valeur est bien injectée.
 */
function origineDuSite(): string {
  const configuree = process.env.SIRIUS_APP_ORIGIN?.trim();
  if (!configuree) return ORIGINE_PAR_DEFAUT;
  try {
    return new URL(configuree).origin;
  } catch {
    return ORIGINE_PAR_DEFAUT;
  }
}

const ORIGINE = origineDuSite();
const TITRE = "Sirius — confidential data lending on EVM";
const DESCRIPTION =
  "Lend valuable datasets without ever exposing them. Training inside a TEE, USDC settlement, and an audit trail on EVM.";

export const metadata: Metadata = {
  // Sans base, Next rend les URL d'images en relatif — et un réseau social qui lit
  // la page depuis ses propres serveurs ne sait alors pas les résoudre. L'aperçu
  // arrive vide, ce qui est pire qu'une absence d'aperçu : le lien paraît cassé.
  metadataBase: new URL(ORIGINE),
  title: TITRE,
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "Sirius",
    url: ORIGINE,
    title: TITRE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: TITRE,
    description: DESCRIPTION,
  },
  // Preuve de propriété du domaine demandée par Virtuals Protocol avant de rattacher
  // le site à la page d'agent. Le jeton n'ouvre aucun accès et ne révèle rien : il
  // atteste seulement qu'on peut modifier le contenu servi sur cette origine.
  //
  // Passe par le champ `verification` plutôt qu'une balise écrite à la main : Next
  // rend alors la balise dans le <head> de chaque page, y compris celles ajoutées
  // plus tard, sans que personne ait à y penser.
  verification: {
    other: {
      "virtual-protocol-site-verification": "394fd0a65d807900243c60d41eb6d129",
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // Le serveur rend l'anglais ; LocaleProvider corrige l'attribut après hydratation
    // si le visiteur a choisi le français. Un moteur de recherche et un lecteur d'écran
    // ne lisent que cette valeur-ci, et Chrome propose de traduire une page qu'il croit
    // francophone.
    <html lang="en" className="h-full antialiased">
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
