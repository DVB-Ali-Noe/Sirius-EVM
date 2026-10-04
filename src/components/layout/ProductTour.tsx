"use client";

import { useEffect } from "react";
import { useWalletStore } from "@/stores/wallet";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { TourDialog } from "@/components/tour/TourDialog";
import { tourController, useTourSnapshot } from "@/components/tour/tour-store";
import { TOUR_UI, WELCOME_STEPS } from "@/lib/tour/content";

export { restartWelcomeTour } from "@/components/tour/tour-store";

/**
 * Tuto de première connexion (docs/passage-mainnet/04-dashboard.md).
 *
 * S'ouvre une fois par wallet, à la première visite d'une page de l'application après une
 * connexion signée. « Déjà vu » vient de la base (`tourCompletedAt` de `/api/profile`),
 * avec un repli dans le navigateur si l'écriture échoue ; les règles d'ouverture et de
 * repli sont dans `src/lib/tour/controller.ts`. Relançable par `restartWelcomeTour()`.
 */
export function ProductTour() {
  const address = useWalletStore((s) => s.address);
  const connected = useWalletStore((s) => s.connected);
  const authenticated = useWalletStore((s) => s.authenticated);
  const { t } = useLocale();
  const { active } = useTourSnapshot();

  useEffect(() => {
    tourController.start();
    tourController.setIdentity(connected ? address : null, connected && authenticated);
  }, [address, connected, authenticated]);

  if (active?.kind !== "welcome") return null;
  return <TourDialog key={`welcome-${active.id}`} eyebrow={t(TOUR_UI.welcomeLabel)} steps={WELCOME_STEPS} onClose={() => tourController.close()} />;
}
