import type { Metadata } from "next";
import "./globals.css";
import SharedBlob from "@/components/layout/SharedBlob";
import { WalletConnector } from "@/components/wallet/WalletConnector";
import { LandingRedirect } from "@/components/layout/LandingRedirect";
import { StoreHydrator } from "@/components/layout/StoreHydrator";
import { E2eWalletBridge } from "@/components/testing/E2eWalletBridge";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";

export const metadata: Metadata = {
  title: "Sirius — data lending confidentiel sur EVM",
  description:
    "Louer des datasets de valeur sans jamais les exposer. Entraînement en TEE, règlement USDC et audit sur EVM.",
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
