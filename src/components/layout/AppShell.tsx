"use client";

import { useEffect } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { ProductTour } from "@/components/layout/ProductTour";
import { ProfileMenu } from "@/components/profile/ProfileMenu";
import { PageTour } from "@/components/tour/PageTour";
import { SecureAccountBanner } from "@/components/wallet/SecureAccount";
import { APP_BACKGROUND_BLOB_Z, useBlobStore } from "@/stores/blob";

/** Cadre des pages de l'application. `demoOnly` : adresse démo, sans menu ni visites guidées. */
export function AppShell({ children, demoOnly = false }: { children: React.ReactNode; demoOnly?: boolean }) {
  const setTargetZ = useBlobStore((s) => s.setTargetZ);

  useEffect(() => {
    setTargetZ(APP_BACKGROUND_BLOB_Z);
    return () => setTargetZ(null);
  }, [setTargetZ]);

  if (demoOnly) {
    return (
      <div className="relative z-10 min-h-full text-foreground">
        <div className="pt-8">
          <ProfileMenu />
          {children}
        </div>
      </div>
    );
  }

  return (
    <div className="relative z-10 min-h-full text-foreground md:pl-[19rem]">
      <Sidebar />
      <ProductTour />
      <PageTour />
      {/* décalage pour la barre mobile (top-16 + nav) ; nul en desktop */}
      <div className="pt-28 md:pt-8">
        <ProfileMenu />
        <SecureAccountBanner />
        {children}
      </div>
    </div>
  );
}
