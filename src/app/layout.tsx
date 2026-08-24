import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import SharedBlob from "@/components/layout/SharedBlob";
import { WalletConnector } from "@/components/wallet/WalletConnector";
import { EmbeddedWalletSync } from "@/components/wallet/EmbeddedWalletSync";
import { LandingRedirect } from "@/components/layout/LandingRedirect";
import { StoreHydrator } from "@/components/layout/StoreHydrator";
import { E2eWalletBridge } from "@/components/testing/E2eWalletBridge";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Sirius — data lending confidentiel sur XRPL",
  description:
    "Louer des datasets de valeur sans jamais les exposer. Entraînement en TEE, règlement et audit sur XRPL.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="fr"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <LocaleProvider>
          <SharedBlob />
          <WalletConnector />
          <EmbeddedWalletSync />
          <E2eWalletBridge />
          <StoreHydrator />
          <LandingRedirect />
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}
