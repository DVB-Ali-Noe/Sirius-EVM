"use client";

import { useEffect } from "react";
import { tourController } from "@/components/tour/tour-store";
import { shouldPromptVerification } from "@/lib/onboarding/steps";
import { useWalletStore } from "@/stores/wallet";
import {
  loadKybGate,
  markPromptShown,
  promptShownThisSession,
  requestVerification,
  resetOnboardingFor,
  useOnboardingStore,
} from "./onboarding-store";
import { VerificationDialog } from "./VerificationDialog";

/** Wallets à qui la fenêtre a été proposée dans cet onglet, si `sessionStorage` est interdit. */
const shownHere = new Set<string>();

/** Fréquence à laquelle on regarde si la place est libre (tuto ou autre fenêtre fermés). */
const PROMPT_POLL_MS = 1_000;

/** Une fenêtre modale du site est-elle déjà ouverte (tuto, ajout de fonds, devis) ? */
function modalOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

/**
 * Porte la fenêtre de vérification pour toute l'application, et la propose une fois par session
 * juste après la connexion quand le wallet n'est pas vérifié et que l'accès instantané est ouvert.
 *
 * Jamais par-dessus une autre fenêtre : la proposition attend que le tuto de bienvenue (qui
 * s'ouvre lui aussi après la première connexion) et toute autre fenêtre modale soient fermés.
 * Neutralisée avec les tutos dans la suite e2e. `autoPrompt` à faux (hôte de démonstration) :
 * la fenêtre ne s'ouvre qu'à la demande d'une garde.
 */
export function OnboardingHost({ autoPrompt = true }: { autoPrompt?: boolean }) {
  const address = useWalletStore((s) => s.address);
  const connected = useWalletStore((s) => s.connected);
  const authenticated = useWalletStore((s) => s.authenticated);
  const signed = connected && authenticated && address ? address.toLowerCase() : null;
  const owner = useOnboardingStore((s) => s.owner);
  const kyb = useOnboardingStore((s) => s.kyb);
  const instantAccess = useOnboardingStore((s) => s.instantAccess);
  const dialog = useOnboardingStore((s) => s.dialog);

  useEffect(() => {
    resetOnboardingFor(signed);
    if (signed) void loadKybGate();
  }, [signed]);

  useEffect(() => {
    if (!autoPrompt || !signed || owner !== signed || kyb !== "missing" || !instantAccess) return;
    if (shownHere.has(signed) || promptShownThisSession(signed)) return;
    const timer = setInterval(() => {
      const tour = tourController.getSnapshot();
      if (tour.suppressed) {
        clearInterval(timer);
        return;
      }
      const ready = shouldPromptVerification({
        authenticated: true,
        kyb,
        instantAccess,
        shownThisSession: shownHere.has(signed) || promptShownThisSession(signed),
        overlayOpen: modalOpen() || useOnboardingStore.getState().dialog !== null,
        tourPending: !tour.started || tour.status === "loading" || tour.active !== null,
      });
      if (!ready) return;
      clearInterval(timer);
      shownHere.add(signed);
      markPromptShown(signed);
      void requestVerification("prompt");
    }, PROMPT_POLL_MS);
    return () => clearInterval(timer);
  }, [autoPrompt, signed, owner, kyb, instantAccess]);

  if (!dialog || !signed || owner !== signed || !address) return null;
  return <VerificationDialog key={dialog.id} reason={dialog.reason} role={dialog.role} address={address} />;
}
