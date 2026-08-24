"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LANDING_RETURN_KEY } from "@/lib/landing-navigation";
import { useWalletStore } from "@/stores/wallet";

/**
 * Post-login = tableau de bord (D-23, pas de page dispatch). Monté globalement mais
 * n'agit que sur la landing (`/`) : dès qu'un wallet s'y connecte, on route vers
 * /dashboard. Sans toucher au fichier de la landing.
 */
export function LandingRedirect() {
  const connected = useWalletStore((s) => s.connected);
  const pathname = usePathname();
  const router = useRouter();
  const allowLanding = useRef(false);

  useEffect(() => {
    if (pathname !== "/") {
      allowLanding.current = false;
      return;
    }

    if (window.sessionStorage.getItem(LANDING_RETURN_KEY) === "true") {
      window.sessionStorage.removeItem(LANDING_RETURN_KEY);
      allowLanding.current = true;
      return;
    }

    if (connected && !allowLanding.current) router.replace("/dashboard");
  }, [connected, pathname, router]);

  return null;
}
