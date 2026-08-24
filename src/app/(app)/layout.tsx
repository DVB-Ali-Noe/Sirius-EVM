"use client";

import { useEffect } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { ProductTour } from "@/components/layout/ProductTour";
import { SecureAccountBanner } from "@/components/wallet/SecureAccount";
import { APP_BACKGROUND_BLOB_Z, useBlobStore } from "@/stores/blob";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const setTargetZ = useBlobStore((s) => s.setTargetZ);

  useEffect(() => {
    setTargetZ(APP_BACKGROUND_BLOB_Z);
    return () => setTargetZ(null);
  }, [setTargetZ]);

  return (
    <div className="relative z-10 min-h-full text-foreground md:pl-[19rem]">
      <Sidebar />
      <ProductTour />
      {/* décalage pour la barre mobile (top-16 + nav) ; nul en desktop */}
      <div className="pt-28 md:pt-8">
        <SecureAccountBanner />
        {children}
      </div>
    </div>
  );
}
