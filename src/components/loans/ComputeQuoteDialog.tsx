"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { Modal } from "@/components/ui/Modal";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useWalletStore } from "@/stores/wallet";
import { totalQuoteAmount, type ComputeQuote } from "@/lib/billing/quote";
import { resolveClientNetwork } from "@/lib/evm/networks";
import { stablecoinSymbol } from "@/lib/evm/stablecoin";

export function useComputeQuoteConfirmation() {
  const [quote, setQuote] = useState<ComputeQuote | null>(null);
  const resolver = useRef<((accepted: boolean) => void) | null>(null);
  const { locale, t } = useLocale();
  const finish = useCallback((accepted: boolean) => {
    resolver.current?.(accepted);
    resolver.current = null;
    setQuote(null);
  }, []);
  useEffect(() => {
    const unsubscribe = useWalletStore.subscribe((state, previous) => {
      if (state.revision !== previous.revision || !state.authenticated) finish(false);
    });
    return () => { unsubscribe(); resolver.current?.(false); resolver.current = null; };
  }, [finish]);
  const confirmQuote = useCallback((next: ComputeQuote) => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    setQuote(next);
  }), []);
  // « USDG » sur mainnet, « test USDC » sur testnet : le réseau est inliné au build.
  const token = t(stablecoinSymbol(resolveClientNetwork()));
  const money = (amount: string) => `${formatUnits(BigInt(amount), quote!.usdcDecimals)} ${token}`;
  const title = quote?.apiAccessDays != null ? t("Devis de l’accès API") : quote?.callPack ? t("Devis du pack d’appels") : t("Devis d’entraînement");
  const dialog = (
    <Modal open={quote !== null} onClose={() => finish(false)} title={title}>
      {quote && <div className="space-y-5" role="dialog" aria-modal="true" aria-label={title}>
        <dl className="space-y-3 text-sm">
          {quote.callPack != null && (
            <div className="flex justify-between gap-4">
              <dt>{t("Appels achetés")}</dt>
              <dd className="font-mono">{quote.callPack.toLocaleString(locale === "fr" ? "fr-FR" : "en-US")}</dd>
            </div>
          )}
          {quote.apiAccessDays != null && (
            <div className="flex justify-between gap-4">
              <dt>{t("Jours d’accès API")}</dt>
              <dd className="font-mono">{quote.apiAccessDays === 1 ? t("1 jour") : t("{days} jours", { days: quote.apiAccessDays })}</dd>
            </div>
          )}
          {quote.rentalDays != null && quote.packForLoanId == null && (
            <div className="flex justify-between gap-4">
              <dt>{quote.extendsLoanId ? t("Jours ajoutés") : t("Durée de location")}</dt>
              <dd className="font-mono">{quote.rentalDays === 1 ? t("1 jour") : t("{days} jours", { days: quote.rentalDays })}</dd>
            </div>
          )}
          <div className="flex justify-between gap-4"><dt>{t("Prix du dataset")}</dt><dd className="font-mono">{money(quote.datasetAmount)}</dd></div>
          <div className="flex justify-between gap-4"><dt>{t("Prix du compute")}</dt><dd className="font-mono">{money(quote.apiAccessAmount ? String(BigInt(quote.computeAmount) - BigInt(quote.apiAccessAmount)) : quote.computeAmount)}</dd></div>
          {quote.apiAccessAmount && (
            <div className="flex justify-between gap-4" data-testid="api-access-included-line">
              <dt>{quote.rentalDays === 1 ? t("Accès API inclus (1 jour)") : t("Accès API inclus ({days} jours)", { days: quote.rentalDays ?? 0 })}</dt>
              <dd className="font-mono">{money(quote.apiAccessAmount)}</dd>
            </div>
          )}
          <div className="flex justify-between gap-4 border-t border-border pt-3 font-semibold"><dt>{t("Total à prépayer")}</dt><dd className="font-mono">{money(totalQuoteAmount(quote))}</dd></div>
        </dl>
        {quote.callPack != null && (
          <p className="text-xs text-muted">{t("Les appels achetés s’ajoutent à cette location, après le quota inclus de chaque jour. Ils expirent avec la location et ne sont pas remboursables.")}</p>
        )}
        {quote.apiAccessDays != null && (
          <p className="text-xs text-muted" data-testid="api-access-quote-note">{t("L’accès API est payé par jour à Sirius, jusqu’à la fin de la location ; le fournisseur reçoit la part minimale de 0,001. Une prolongation d’une location ainsi couverte jusqu’à son échéance inclut l’API d’office pour les jours ajoutés. Non remboursable une fois activé.")}</p>
        )}
        {quote.apiAccessIncluded && (
          <p className="text-xs text-muted" data-testid="api-access-included-note">{quote.extendsLoanId
            ? t("Ta location a l’accès API jusqu’à son échéance : la prolongation l’inclut pour les jours ajoutés, au tarif journalier de l’API.")
            : t("Toute location inclut l’accès API pour toute sa durée, au tarif journalier ; une clé est créée pour toi après le règlement et une prolongation garde l’API. En cas d’échec de l’entraînement, il est remboursé avec le reste, hors frais d’exécution mesurés.")}</p>
        )}
        {quote.extendsLoanId && !quote.apiAccessIncluded && (
          <p className="text-xs text-muted" data-testid="extension-api-note">{t("La prolongation ne comprend pas l’accès API : si tu utilises l’API, elle s’arrêtera à sa date payée actuelle et les jours ajoutés se paient ensuite depuis le panneau API.")}</p>
        )}
        <div className="rounded-lg border border-border bg-background/40 p-3 text-xs leading-relaxed text-muted">
          <p>{t("En cas d’échec, le dataset et le compute non consommé sont remboursés. Seuls les frais d’exécution mesurés sont retenus.")}</p>
          <p className="mt-2 font-medium text-foreground">{t("Retenue maximale")} : {money(quote.maxFailureFee)}</p>
          <p className="mt-1">{t("Barème d’exécution, transferts inclus")} : {money(String(BigInt(quote.executionRateAtomicPerMs) * BigInt(1000)))} / s · {t("Durée maximale")} : {quote.maxExecutionMs / 1000} s</p>
        </div>
        <p className="text-xs text-muted">{t("Les frais réseau ETH sont payés séparément dans ton wallet. Aucun supplément automatique.")}</p>
        <p className="text-xs text-muted">{t("Devis valable jusqu’à")} {new Date(quote.expiresAt * 1000).toLocaleTimeString()} · {quote.tariffVersion}</p>
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" onClick={() => finish(false)} className="rounded-lg border border-border px-4 py-2 text-sm">{t("Annuler")}</button>
          <button type="button" autoFocus onClick={() => finish(true)} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-background">{t("Accepter et prépayer")}</button>
        </div>
      </div>}
    </Modal>
  );
  return { confirmQuote, quoteDialog: dialog };
}
