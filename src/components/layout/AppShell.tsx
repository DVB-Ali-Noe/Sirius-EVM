"use client";

import { useEffect } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { ProductTour } from "@/components/layout/ProductTour";
import { ProfileMenu } from "@/components/profile/ProfileMenu";
import { PageTour } from "@/components/tour/PageTour";
import { SecureAccountBanner } from "@/components/wallet/SecureAccount";
import { APP_BACKGROUND_BLOB_Z, useBlobStore } from "@/stores/blob";
import { useUiStore, useUiTransitionsReady } from "@/stores/ui";

/** Cadre des pages de l'application. `demoOnly` : adresse démo, sans menu ni visites guidées. */
export function AppShell({ children, demoOnly = false }: { children: React.ReactNode; demoOnly?: boolean }) {
  const setTargetZ = useBlobStore((s) => s.setTargetZ);
  const collapsed = useUiStore((s) => s.sidebarCollapsed && !s.sidebarPeek);
  const hydrated = useUiTransitionsReady();

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
    <div
      className={`relative z-10 min-h-full text-foreground ${hydrated ? "transition-[padding] duration-300 ease-out motion-reduce:transition-none" : ""} ${
        collapsed ? "md:pl-28" : "md:pl-[19rem]"
      }`}
    >
      <Sidebar />
      <ProductTour />
      <PageTour />
      {/* décalage pour la barre mobile (top-16 + nav) ; nul en desktop */}
      <div className="pt-32 md:pt-8">
        <ProfileMenu />
        <SecureAccountBanner />
        {children}
      </div>
    </div>
  );
}
