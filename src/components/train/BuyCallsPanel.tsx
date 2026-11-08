"use client";

import { useRef, useState } from "react";
import { formatWaitElapsed, WaitSteps, type WaitStep } from "@/components/ui/WaitSteps";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { CALL_PACK_SIZES, packDatasetAmount, type CallPackSize } from "@/lib/billing/api-pricing";
import type { ComputeQuote } from "@/lib/billing/quote";
import { buyCalls, type PaidSettlementStage } from "@/lib/loans/client";
import { isSettlementPending } from "@/lib/loans/settlement-status";
import { messageOf } from "@/lib/errors-client";
import { retryWhileEnclaveStarts } from "@/lib/train/enclave-wait";
import { EnclaveStartingSteps } from "./EnclaveStartingSteps";
import { useUnmountSignal } from "@/components/ui/useUnmountSignal";
import { useElapsedSeconds } from "@/components/ui/useElapsedSeconds";

/** Pack payé dont les appels ne sont pas encore crédités (prêt de pack non réglé). */
export interface PendingCallPack {
  id: string;
  size: number;
  stage: "payment" | "finality" | "crediting";
  /** Attente de finalité restante, lue par le suivi existant de la page (`lock-finality-tracker`). */
  remainingSeconds: number | null;
}

type BuyPhase = "preparing" | "quote" | "payment" | PaidSettlementStage;

/** Prix fournisseur d'un pack, ou `null` si le prix du dataset ou le quota est inconnu. */
export function packPrice(priceUsdcAtomic: string | null | undefined, callsPerDay: number | null | undefined, size: CallPackSize): string | null {
  if (!priceUsdcAtomic || !callsPerDay) return null;
  try {
    return packDatasetAmount(priceUsdcAtomic, callsPerDay, size);
  } catch {
    return null;
  }
}

/**
 * Achat d'appels prépayés (D-30) : taille, devis signé, paiement dans le wallet (même lock qu'un
 * emprunt), puis crédit par l'enclave, que la page termine elle-même tant qu'elle reste ouverte.
 * Les appels s'ajoutent au prêt d'origine, après le quota du jour.
 */
export function BuyCallsPanel({
  loanId,
  datasetId,
  priceUsdcAtomic,
  callsPerDay,
  money,
  confirmQuote,
  pendingPacks,
  onPurchased,
}: {
  loanId: string;
  datasetId: string;
  priceUsdcAtomic: string | null | undefined;
  callsPerDay: number;
  money: (atomic: string) => string;
  confirmQuote: (quote: ComputeQuote) => Promise<boolean>;
  pendingPacks: readonly PendingCallPack[];
  onPurchased: () => Promise<void>;
}) {
  const { locale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState<CallPackSize>(CALL_PACK_SIZES[0]);
  const [phase, setPhase] = useState<BuyPhase | null>(null);
  const [settlingSince, setSettlingSince] = useState<number | null>(null);
  const [enclaveRetry, setEnclaveRetry] = useState<number | null>(null);
  const unmountSignal = useUnmountSignal();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const running = useRef(false);
  const elapsed = useElapsedSeconds(settlingSince);
  const count = (value: number) => value.toLocaleString(locale === "fr" ? "fr-FR" : "en-US");

  async function buy() {
    if (running.current) return;
    running.current = true;
    setError(null);
    setNotice(null);
    setPhase("preparing");
    const signal = unmountSignal();
    try {
      const outcome = await retryWhileEnclaveStarts(() => buyCalls({
        loanId,
        datasetId,
        size,
        confirmQuote: async (quote) => {
          setPhase("quote");
          const ok = await confirmQuote(quote);
          if (ok) setPhase("payment");
          return ok;
        },
        settlement: {
          signal,
          onEnclaveWaiting: setEnclaveRetry,
          onStage: (stage) => {
            setPhase(stage);
            setSettlingSince((since) => since ?? Date.now());
          },
        },
      }), { onWaiting: setEnclaveRetry, signal });
      if (outcome) setOpen(false);
      if (outcome === "settled") setNotice(t("Pack réglé : {count} appels crédités à l’emprunt d’origine.", { count: count(size) }));
      // Budget de la page écoulé : le reaper termine, même page fermée.
      if (outcome === "deferred") setNotice(t("Pack payé : les appels sont crédités dès la confirmation du paiement, même si tu fermes la page."));
      await onPurchased();
    } catch (cause) {
      if (signal.aborted) return;
      const message = messageOf(cause);
      // Paiement acquis, règlement en attente : le serveur crédite seul, ce n'est pas un échec.
      if (isSettlementPending(message)) setNotice(message);
      else setError(message);
      await onPurchased().catch(() => {});
    } finally {
      running.current = false;
      setPhase(null);
      setSettlingSince(null);
    }
  }

  const order: readonly BuyPhase[] = ["preparing", "quote", "payment", "confirming", "activating"];
  const current = phase ? order.indexOf(phase) : -1;
  const status = (index: number): WaitStep["status"] => (index < current ? "done" : index === current ? "active" : "pending");
  const settling = phase === "confirming" || phase === "activating";
  const progress = formatWaitElapsed(elapsed);
  const steps: WaitStep[] = [
    { id: "quote", label: t("Devis signé par l’enclave"), status: status(0) },
    { id: "accept", label: t("Acceptation du devis"), status: status(1) },
    { id: "payment", label: t("Paiement dans ton wallet (approbation puis verrouillage)"), status: status(2) },
    { id: "finality", label: t("Confirmation du paiement par le réseau"), status: status(3), detail: phase === "confirming" ? t("En général quelques secondes") : undefined },
    { id: "credit", label: t("Crédit des appels dans l’enclave"), status: status(4) },
  ];

  return (
    <div className="mt-3 space-y-3" data-testid="buy-calls">
      {pendingPacks.map((pack) => {
        const stage = ["payment", "finality", "crediting"].indexOf(pack.stage);
        const packStatus = (index: number): WaitStep["status"] => (index < stage ? "done" : index === stage ? "active" : "pending");
        return (
          <WaitSteps
            key={pack.id}
            testId="call-pack-pending"
            title={t("Pack de {count} appels en cours", { count: count(pack.size) })}
            steps={[
              { id: "payment", label: t("Paiement envoyé à l’escrow"), status: packStatus(0) },
              { id: "finality", label: t("Confirmation du paiement par le réseau"), status: packStatus(1) },
              { id: "crediting", label: t("Crédit des appels dans l’enclave"), status: packStatus(2) },
            ]}
            remainingSeconds={pack.stage === "finality" ? pack.remainingSeconds : null}
            canClose
            closeNote={t("Tu peux fermer cette page : le paiement est en sécurité dans l’escrow et les appels sont crédités automatiquement.")}
          />
        );
      })}
      {notice && <p role="status" data-testid="buy-calls-notice" className="text-xs text-positive">{t(notice)}</p>}
      {error && <p role="alert" className="text-xs text-negative">{t(error)}</p>}
      {open ? (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <fieldset className="flex flex-wrap gap-2" disabled={phase !== null}>
            <legend className="mb-2 text-xs text-muted">{t("Taille du pack")}</legend>
            {CALL_PACK_SIZES.map((option) => {
              const price = packPrice(priceUsdcAtomic, callsPerDay, option);
              return (
                <label
                  key={option}
                  className={`cursor-pointer rounded-lg border px-3 py-2 text-xs ${size === option ? "border-accent text-foreground" : "border-border text-muted"}`}
                >
                  <input type="radio" name={`pack-${loanId}`} value={option} checked={size === option} onChange={() => setSize(option)} className="sr-only" />
                  <span className="block font-medium">{t("{count} appels", { count: count(option) })}</span>
                  <span className="block font-mono">{price ? money(price) : "—"}</span>
                </label>
              );
            })}
          </fieldset>
          <p className="text-xs text-muted">
            {t("Prix d’un appel : prix par jour ÷ {calls} appels inclus par jour, arrondi au supérieur. S’ajoutent les frais de calcul de Sirius, à prix coûtant ; le total exact est dans le devis, avant tout paiement. Les appels expirent avec la location et ne sont pas remboursables.", { calls: callsPerDay })}
          </p>
          {phase && (
            <WaitSteps
              testId="buy-calls-steps"
              steps={steps}
              progress={settling ? t(progress.key, progress.params) : undefined}
              closeNote={settling
                ? t("Garde cette page ouverte : l’activation se termine ici dès la confirmation du réseau.")
                : t("Garde la page ouverte jusqu’à la signature du paiement ; ensuite, les appels sont crédités même si tu la fermes.")}
            />
          )}
          {enclaveRetry !== null && <EnclaveStartingSteps phase="starting" retryInSeconds={enclaveRetry} testId="buy-calls-enclave-starting" />}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void buy()}
              disabled={phase !== null}
              aria-busy={phase !== null}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              {phase ? t("Achat…") : t("Voir le devis et acheter")}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={phase !== null}
              className="rounded-xl px-3 py-2 text-sm text-muted transition-colors hover:text-foreground disabled:opacity-50"
            >
              {t("Annuler")}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-block rounded-lg border border-accent/40 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:border-accent"
        >
          {t("Acheter des appels")}
        </button>
      )}
    </div>
  );
}
