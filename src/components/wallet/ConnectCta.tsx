"use client";

import { openWalletModal } from "./WalletConnector";

/** CTA de connexion simple (ouvre le modal). Le bouton complet avec dropdown/déco est ConnectButton. */
export function ConnectCta({
  children,
  size = "md",
}: {
  children: React.ReactNode;
  size?: "md" | "lg";
}) {
  const sizeCls = size === "lg" ? "px-8 py-4 text-base" : "px-5 py-2.5 text-sm";
  return (
    <button
      onClick={openWalletModal}
      className={`rounded-xl bg-accent ${sizeCls} font-medium text-background transition-colors hover:bg-accent/90`}
    >
      {children}
    </button>
  );
}
