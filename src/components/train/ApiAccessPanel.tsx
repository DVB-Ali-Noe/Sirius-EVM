"use client";

import { useRef, useState } from "react";
import { WaitSteps, type WaitStep } from "@/components/ui/WaitSteps";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useUnmountSignal } from "@/components/ui/useUnmountSignal";
import type { ComputeQuote } from "@/lib/billing/quote";
import { buyApiAccess } from "@/lib/loans/client";
import { isSettlementPending } from "@/lib/loans/settlement-status";
import { messageOf } from "@/lib/errors-client";
import type { ApiKeysOverview } from "@/lib/train/api-keys-client";
import { retryWhileEnclaveStarts } from "@/lib/train/enclave-wait";
import { EnclaveStartingSteps } from "./EnclaveStartingSteps";
import type { PendingCallPack } from "./BuyCallsPanel";

type BuyPhase = "preparing" | "quote" | "payment";

/** Pass refusé pour toujours par l'enclave (base du prix changée) : rien versé, remboursable à l'échéance de l'escrow. */
export interface RefusedPass {
  id: string;
  refundableAt: string | null;
}

/**
 * Accès API payé au jour (D-32) : état de la couverture, achat du pass jusqu'à l'échéance (devis
 * signé par l'enclave, puis même paiement qu'un pack) et complément après une prolongation.
 * Sans pass couvrant l'instant présent, l'API refuse tout appel et aucune clé ne se crée.
 */
export function ApiAccessPanel({
  loanId,
  datasetId,
  access,
  closed,
  money,
  confirmQuote,
  pendingPasses,
  refusedPasses,
  onPurchased,
}: {
  loanId: string;
  datasetId: string;
  access: ApiKeysOverview["apiAccess"];
  /** Moins d'une heure de location : le pass ne servirait presque pas (refusé par le runner). */
  closed: boolean;
  money: (atomic: string) => string;
  confirmQuote: (quote: ComputeQuote) => Promise<boolean>;
  pendingPasses: readonly PendingCallPack[];
  refusedPasses: readonly RefusedPass[];
  onPurchased: () => Promise<void>;
}) {
  const { locale, t } = useLocale();
  const [phase, setPhase] = useState<BuyPhase | null>(null);
  const [enclaveRetry, setEnclaveRetry] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const running = useRef(false);
  const unmountSignal = useUnmountSignal();
  const date = (iso: string) => new Date(iso).toLocaleString(locale === "fr" ? "fr-FR" : "en-US", { dateStyle: "medium", timeStyle: "short" });
  const paid = access.paid;
  const topUp = paid && access.daysToBuy > 0;

  async function buy() {
    if (running.current) return;
    running.current = true;
    setError(null);
    setNotice(null);
    setPhase("preparing");
    try {
      const accepted = await retryWhileEnclaveStarts(() => buyApiAccess({
        loanId,
        datasetId,
        confirmQuote: async (quote) => {
          setPhase("quote");
          const ok = await confirmQuote(quote);
          if (ok) setPhase("payment");
          return ok;
        },
      }), { onWaiting: setEnclaveRetry, signal: unmountSignal() });
      if (accepted) setNotice(t("Accès API payé : il s’active dès la confirmation du paiement, même si tu fermes la page."));
      await onPurchased();
    } catch (cause) {
      const message = messageOf(cause);
      if (isSettlementPending(message)) setNotice(message);
      else setError(message);
      await onPurchased().catch(() => {});
    } finally {
      running.current = false;
      setPhase(null);
    }
  }

  const order: readonly BuyPhase[] = ["preparing", "quote", "payment"];
  const current = phase ? order.indexOf(phase) : -1;
  const status = (index: number): WaitStep["status"] => (index < current ? "done" : index === current ? "active" : "pending");
  const days = access.daysToBuy === 1 ? t("1 jour") : t("{days} jours", { days: access.daysToBuy });

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-border p-3 text-xs" data-testid="api-access">
      <p className="font-medium text-foreground" data-testid="api-access-status">
        {paid
          ? access.included
            ? t("API incluse, payée jusqu’au {date}", { date: date(access.paidUntil!) })
            : t("API payée jusqu’au {date}", { date: date(access.paidUntil!) })
          : access.paidUntil
            ? t("Accès API terminé le {date}", { date: date(access.paidUntil) })
            : t("API non activée")}
      </p>
      {access.dailyFee === null ? (
        <p className="text-muted" data-testid="api-access-not-for-sale">
          {t("L’accès API n’est pas en vente pour le moment : sans pass payé, aucune clé ne peut être créée et l’API refuse les appels.")}
        </p>
      ) : (
        <p className="text-muted">
          {t("L’API est payée par jour : {fee} par jour jusqu’à la fin de la location, plus 0,001 au fournisseur. Les prédictions depuis le site restent incluses.", { fee: money(access.dailyFee) })}
        </p>
      )}
      {topUp && (
        <p className="text-muted" data-testid="api-access-top-up">
          {t("La location a été prolongée : l’API s’arrête le {date}. Paie les jours ajoutés pour la garder active jusqu’au {end}.", { date: date(access.paidUntil!), end: date(access.rentalExpiresAt) })}
        </p>
      )}
      {refusedPasses.map((pass) => (
        <p key={pass.id} className="text-negative" data-testid="api-access-refused-pass">
          {pass.refundableAt
            ? t("Pass d’accès API refusé (couverture ou échéance changée depuis son devis) : rien n’a été versé, remboursable le {date}.", { date: date(pass.refundableAt) })
            : t("Pass d’accès API refusé (couverture ou échéance changée depuis son devis) : rien n’a été versé, remboursable à l’échéance de l’escrow.")}
        </p>
      ))}
      {pendingPasses.map((pass) => {
        const stage = ["payment", "finality", "crediting"].indexOf(pass.stage);
        const passStatus = (index: number): WaitStep["status"] => (index < stage ? "done" : index === stage ? "active" : "pending");
        return (
          <WaitSteps
            key={pass.id}
            testId="api-access-pending"
            title={t("Accès API en cours d’activation")}
            steps={[
              { id: "payment", label: t("Paiement envoyé à l’escrow"), status: passStatus(0) },
              { id: "finality", label: t("Confirmation du paiement par le réseau"), status: passStatus(1) },
              { id: "crediting", label: t("Activation de l’accès API dans l’enclave"), status: passStatus(2) },
            ]}
            remainingSeconds={pass.stage === "finality" ? pass.remainingSeconds : null}
            canClose
            closeNote={t("Tu peux fermer cette page : le paiement est en sécurité dans l’escrow et l’accès API s’active automatiquement.")}
          />
        );
      })}
      {notice && <p role="status" data-testid="api-access-notice" className="text-positive">{t(notice)}</p>}
      {error && <p role="alert" className="text-negative">{t(error)}</p>}
      {phase && (
        <WaitSteps
          testId="api-access-steps"
          steps={[
            { id: "quote", label: t("Devis signé par l’enclave"), status: status(0) },
            { id: "accept", label: t("Acceptation du devis"), status: status(1) },
            { id: "payment", label: t("Paiement dans ton wallet (approbation puis verrouillage)"), status: status(2) },
            { id: "activate", label: t("Confirmation du paiement et activation de l’accès API"), status: "pending" },
          ]}
          closeNote={t("Garde la page ouverte jusqu’à la signature du paiement ; ensuite, l’accès API s’active même si tu la fermes.")}
        />
      )}
      {enclaveRetry !== null && <EnclaveStartingSteps phase="starting" retryInSeconds={enclaveRetry} testId="api-access-enclave-starting" />}
      {access.dailyFee !== null && access.price !== null && access.daysToBuy > 0 && pendingPasses.length === 0 && (
        closed ? (
          <p className="text-muted">{t("Moins d’une heure de location restante : prolonge avant d’activer l’API")}</p>
        ) : (
          <button
            type="button"
            onClick={() => void buy()}
            disabled={phase !== null}
            aria-busy={phase !== null}
            data-testid="buy-api-access"
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            {phase
              ? t("Achat…")
              : topUp
                ? t("Prolonger l’API — {amount} pour {days}", { amount: money(access.price), days })
                : t("Activer l’API — {amount} pour {days}", { amount: money(access.price), days })}
          </button>
        )
      )}
    </div>
  );
}
