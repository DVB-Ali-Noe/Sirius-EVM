"use client";

import { formatWaitElapsed, WaitSteps, type WaitStep } from "@/components/ui/WaitSteps";
import { useElapsedSeconds } from "@/components/ui/useElapsedSeconds";
import { useLocale } from "@/components/i18n/LocaleProvider";
import type { PaidSettlementProgress } from "@/lib/loans/client";

/**
 * Achat payé (pack, pass, prolongation) dont la page termine le règlement (D-30) : étapes d'avant
 * paiement (`leading`), puis confirmation du réseau et activation, avec le temps écoulé. Sans
 * `progress`, le paiement n'est pas encore envoyé : étapes suivantes en attente, `prePaymentNote`.
 * Enclave en démarrage après paiement : étape dédiée qui dit que le paiement est reçu, jamais
 * l'attente d'avant paiement (`EnclaveStartingSteps`, « rien n'est payé »).
 */
export function PaidSettlementSteps({
  leading,
  progress,
  since,
  activation,
  prePaymentNote,
  testId,
}: {
  leading: readonly WaitStep[];
  progress: PaidSettlementProgress | null;
  /** Début de l'attente du règlement (ms), pour le temps écoulé. */
  since: number | null;
  /** Dernière étape (déjà traduite) : crédit des appels, activation de l'API, jours ajoutés. */
  activation: { id: string; label: string };
  prePaymentNote?: string;
  testId: string;
}) {
  const { t } = useLocale();
  const elapsed = formatWaitElapsed(useElapsedSeconds(progress ? since : null));
  const enclave = progress?.enclaveRetryInSeconds ?? null;
  const confirming = progress?.stage === "confirming" && enclave === null;
  const activating = progress?.stage === "activating" && enclave === null;
  const steps: WaitStep[] = [
    ...leading,
    ...(enclave === null ? [] : [{
      id: "enclave",
      label: t("Démarrage de l’enclave sécurisée : ton paiement est bien reçu, l’activation reprend toute seule"),
      status: "active" as const,
      detail: t("Nouvel essai dans ~{seconds} s", { seconds: enclave }),
    }]),
    {
      id: "finality",
      label: t("Confirmation du paiement par le réseau"),
      status: progress?.stage === "activating" ? "done" : confirming ? "active" : "pending",
      detail: confirming ? t("En général quelques secondes") : undefined,
    },
    { id: activation.id, label: activation.label, status: activating ? "active" : "pending" },
  ];
  return (
    <WaitSteps
      testId={testId}
      steps={steps}
      progress={progress ? t(elapsed.key, elapsed.params) : undefined}
      closeNote={progress ? t("Garde cette page ouverte : l’activation se termine ici dès la confirmation du réseau.") : prePaymentNote}
    />
  );
}
