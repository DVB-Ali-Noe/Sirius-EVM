"use client";

import { useSyncExternalStore } from "react";
import { SERVER_TOUR_SNAPSHOT, TourController, type TourSnapshot } from "@/lib/tour/controller";
import { toursSuppressedForE2e, type StorageLike } from "@/lib/tour/progress";
import type { TourPageKey } from "@/lib/tour/keys";
import { GUIDED_TOUR_EVENT } from "@/components/profile/guided-tour";

/** `localStorage`, ou `null` s'il est absent ou interdit (navigation privée, iframe sandboxée). */
function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Contrôleur unique de l'onglet. Instancié au chargement du module, mais il ne fait rien
 * tant qu'un composant monté ne l'a pas démarré : côté serveur, seul l'instantané
 * `SERVER_TOUR_SNAPSHOT` est lu.
 */
export const tourController = new TourController({
  fetch: (input, init) => fetch(input, init),
  storage: browserStorage,
  isSuppressed: () => toursSuppressedForE2e(process.env.NEXT_PUBLIC_SIRIUS_E2E, browserStorage()),
});

const serverSnapshot = (): TourSnapshot => SERVER_TOUR_SNAPSHOT;

export function useTourSnapshot(): TourSnapshot {
  return useSyncExternalStore(tourController.subscribe, tourController.getSnapshot, serverSnapshot);
}

/**
 * Relance le tuto de première connexion. À brancher sur le bouton « Visite guidée » du
 * menu profil ([05](../../../docs/passage-mainnet/05-wallet.md)). Fonctionne connecté ou
 * non ; la fermeture n'écrit en base que pour un wallet authentifié.
 */
export function restartWelcomeTour(): void {
  tourController.restartWelcome();
}

/**
 * Abonne `restart` à la demande « Visite guidée » du menu profil (`sirius:guided-tour:start`,
 * voir `src/components/profile/guided-tour.ts`). `preventDefault()` sert d'accusé de
 * réception : sans lui le menu afficherait « bientôt disponible ». Renvoie le désabonnement.
 */
export function subscribeGuidedTourRequests(target: EventTarget = window, restart: () => void = restartWelcomeTour): () => void {
  const onStart = (event: Event) => {
    event.preventDefault();
    restart();
  };
  target.addEventListener(GUIDED_TOUR_EVENT, onStart);
  return () => target.removeEventListener(GUIDED_TOUR_EVENT, onStart);
}

/** Relance le tuto d'une page donnée (utilisé par le bouton « ? »). */
export function openPageTour(key: TourPageKey): void {
  tourController.openPage(key);
}
