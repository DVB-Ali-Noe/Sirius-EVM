"use client";

import { useEffect, useState } from "react";
import { WaitSteps } from "@/components/ui/WaitSteps";
import { useLocale } from "@/components/i18n/LocaleProvider";

/** Durée habituelle d'un démarrage de CVM Phala, attestation comprise (estimation affichée). */
export const ENCLAVE_START_ESTIMATE_SECONDS = 4 * 60;

/**
 * Démarrage de l'enclave (D-30) : la machine confidentielle est arrêtée hors usage ; une action
 * wallet (emprunteur, fournisseur qui publie) ou une clé API la rallume. `retryInSeconds` : relance
 * automatique prévue.
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
  // Compte à rebours depuis l'affichage de l'attente : estimation, pas une promesse.
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    if (!requested) return;
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [requested]);
  const remaining = requested ? ENCLAVE_START_ESTIMATE_SECONDS - Math.floor((now - startedAt) / 1000) : null;
  return (
    <WaitSteps
      testId={testId}
      title={t("L’enclave démarre")}
      steps={[
        { id: "requested", label: t("Démarrage demandé"), status: requested ? "done" : "active" },
        {
          id: "booting",
          label: t("Démarrage de la machine confidentielle"),
          status: requested ? "active" : "pending",
          detail: t("Quelques minutes : Sirius n’allume l’enclave que lorsqu’elle sert, et la paie."),
        },
        {
          id: "attested",
          label: t("Vérification de l’enclave, puis reprise automatique"),
          status: "pending",
          detail: retryInSeconds != null ? t("Nouvel essai dans ~{seconds} s", { seconds: retryInSeconds }) : undefined,
        },
      ]}
      remainingSeconds={remaining}
      canClose
      closeNote={closeNote}
    />
  );
}
