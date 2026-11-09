"use client";

import { useState } from "react";
import { formatWaitElapsed, WaitSteps } from "@/components/ui/WaitSteps";
import { useElapsedSeconds } from "@/components/ui/useElapsedSeconds";
import { useLocale } from "@/components/i18n/LocaleProvider";

/** Au-delà, l'explication cède la place à un message rassurant (démarrage mesuré : environ 2 min). */
export const ENCLAVE_SLOW_START_SECONDS = 4 * 60;

/**
 * Démarrage de l'enclave (D-30) : la machine confidentielle est arrêtée hors usage ; une action
 * wallet (emprunteur, fournisseur qui publie) ou un appel de l'API la rallume. Environ 2 minutes
 * mesurées du clic à la reprise automatique (8 novembre 2026 : 2 min 01 s à 2 min 14 s). Le temps
 * écoulé part de l'affichage de l'attente et se met à jour chaque seconde, en texte seul (rien
 * n'est animé de plus que l'étape en cours de `WaitSteps`). `retryInSeconds` : relance prévue.
 */
export function EnclaveStartingSteps({
  phase,
  retryInSeconds,
  closeNote,
  testId = "enclave-starting",
}: {
  phase: "stopped" | "starting" | "stopping";
  retryInSeconds?: number | null;
  closeNote?: string;
  testId?: string;
}) {
  const { t } = useLocale();
  const requested = phase === "starting" || retryInSeconds != null;
  const [startedAt] = useState(() => Date.now());
  const elapsed = useElapsedSeconds(startedAt);
  const progress = formatWaitElapsed(elapsed);
  return (
    <WaitSteps
      testId={testId}
      title={t("Démarrage de l’enclave sécurisée — environ 2 minutes")}
      description={elapsed >= ENCLAVE_SLOW_START_SECONDS
        ? t("Plus long que d’habitude : le démarrage peut prendre jusqu’à 5 minutes. Garde cette page ouverte.")
        : t("Vos données ne sont traitées que dans une machine confidentielle (TEE Intel TDX). Pour limiter les coûts, elle n’est allumée que lorsqu’on en a besoin : elle démarre, puis prouve son identité (attestation) avant de recevoir quoi que ce soit. Rien n’est payé ni envoyé pendant l’attente ; l’opération reprend toute seule.")}
      steps={[
        { id: "requested", label: t("Démarrage demandé"), status: requested ? "done" : "active" },
        { id: "booting", label: t("Démarrage de la machine confidentielle (≈ 1 min 30)"), status: requested ? "active" : "pending" },
        {
          id: "attested",
          label: t("Vérification de l’attestation, puis reprise automatique (≈ 30 s)"),
          status: "pending",
          detail: retryInSeconds != null ? t("Nouvel essai dans ~{seconds} s", { seconds: retryInSeconds }) : undefined,
        },
      ]}
      progress={t(progress.key, progress.params)}
      canClose
      closeNote={closeNote}
    />
  );
}
