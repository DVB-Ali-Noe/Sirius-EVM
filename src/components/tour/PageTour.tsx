"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { PAGE_TOURS, TOUR_UI } from "@/lib/tour/content";
import { TourDialog } from "./TourDialog";
import { openPageTour, tourController, useTourSnapshot } from "./tour-store";

/**
 * Tuto de la page courante (docs/passage-mainnet/02-general.md, section 1), monté une
 * seule fois depuis le layout de l'application : aucune page n'a à le connaître.
 *
 * - Première visite d'une page dotée d'un tuto, wallet connecté et signé : le tuto s'ouvre
 *   (sauf si le tuto de première connexion passe d'abord, voir `controller.ts`).
 * - Le bouton « ? », en bas à droite, relance le tuto de la page, connecté ou non.
 * - Sans wallet, rien ne s'ouvre tout seul : la page reste entièrement utilisable.
 */
export function PageTour() {
  const pathname = usePathname();
  const { t } = useLocale();
  const { started, suppressed, active, pageKey } = useTourSnapshot();

  useEffect(() => {
    tourController.start();
    tourController.setPath(pathname);
  }, [pathname]);

  // Sortie des pages de l'application (/docs, accueil) : plus d'ouverture automatique
  // pour un chemin qui n'est plus affiché.
  useEffect(() => () => tourController.leavePages(), []);

  const dialog =
    active?.kind === "page" ? (
      <TourDialog
        key={`page-${active.key}-${active.id}`}
        eyebrow={t(TOUR_UI.pageLabel)}
        steps={[PAGE_TOURS[active.key]]}
        onClose={() => tourController.close()}
      />
    ) : null;

  // Le bouton n'existe qu'après le montage (pas de rendu serveur divergent). Il reste monté
  // pendant que la fenêtre est ouverte (elle le recouvre) pour que le focus lui revienne
  // à la fermeture.
  const showButton = started && !suppressed && pageKey !== null;

  return (
    <>
      {showButton && (
        <button
          type="button"
          onClick={() => openPageTour(pageKey)}
          aria-label={t(TOUR_UI.helpButton)}
          aria-haspopup="dialog"
          title={t(TOUR_UI.helpButton)}
          className="fixed bottom-4 right-4 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface/80 text-sm font-semibold text-muted shadow-lg backdrop-blur-sm transition-colors hover:border-white/20 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent print:hidden"
        >
          <span aria-hidden="true">?</span>
        </button>
      )}
      {dialog}
    </>
  );
}
