"use client";

import { useLocale } from "@/components/i18n/LocaleProvider";
import {
  computePriceBreakdown,
  formatTokenWithSymbol,
  type AtomicAmount,
  parseAtomic,
  type TokenInfo,
} from "./price";

/** Qui regarde : adapte les libellés (« You receive », « You pay »). Par défaut : neutre. */
export type PriceBreakdownPerspective = "neutral" | "provider" | "borrower";

interface PriceBreakdownProps {
  /** Montant que reçoit le fournisseur par jour de location (D-29), en unités atomiques. */
  providerAtomic: AtomicAmount;
  /**
   * Jours de location choisis : la part du fournisseur affichée vaut alors prix par jour × jours,
   * et le minimum du tarif (qui porte sur le prix par jour) n'est pas rappelé. Absent : un jour.
   */
  rentalDays?: number;
  /** Frais de calcul (enclave Phala), en unités atomiques. */
  computeAtomic: AtomicAmount;
  /**
   * Accès API inclus à toute location (D-32), par jour loué, en unités atomiques : la ligne affiche
   * jours × tarif et l'ajoute au total. Absent ou `null` : pas d'API (régression linéaire, v6).
   */
  apiAccessDailyAtomic?: AtomicAmount | null;
  token: TokenInfo;
  /** Minimum imposé par le tarif sur la part du fournisseur, en unités atomiques. */
  minimumAtomic?: AtomicAmount | null;
  perspective?: PriceBreakdownPerspective;
  className?: string;
}

/**
 * À monter une fois les deux montants connus : une valeur absente ou mal formée affiche
 * « — » et une alerte, jamais un montant approché.
 */
export function PriceBreakdown({
  providerAtomic,
  rentalDays,
  computeAtomic,
  apiAccessDailyAtomic,
  token,
  minimumAtomic,
  perspective = "neutral",
  className = "",
}: PriceBreakdownProps) {
  const { t } = useLocale();
  const perDay = parseAtomic(providerAtomic);
  const rented = rentalDays === undefined || perDay === null ? providerAtomic : perDay * BigInt(rentalDays);
  const days = rentalDays ?? 1;
  const apiPerDay = apiAccessDailyAtomic === undefined || apiAccessDailyAtomic === null ? null : parseAtomic(apiAccessDailyAtomic);
  const withApi = apiAccessDailyAtomic !== undefined && apiAccessDailyAtomic !== null;
  const breakdown = computePriceBreakdown({
    providerAtomic: rented,
    computeAtomic,
    // Tarif illisible : transmis tel quel, pour que le total soit refusé plutôt qu'approché.
    apiAccessAtomic: !withApi ? null : apiPerDay === null ? apiAccessDailyAtomic : apiPerDay * BigInt(days),
    decimals: token.decimals,
    minimumAtomic: rentalDays === undefined ? minimumAtomic : null,
  });
  // Montant invalide : on affiche « — », jamais un montant approximatif ni une exception.
  const show = (amount: bigint | null) => (amount === null ? null : formatTokenWithSymbol(amount, token)) ?? "—";
  const ok = breakdown.ok;
  const providerLabel = perspective === "provider" ? t("Vous recevez") : t("Le fournisseur reçoit");
  const providerDetail =
    rentalDays === undefined || perDay === null
      ? null
      : t("{days} j × {price} par jour", { days: rentalDays, price: show(perDay) });
  const totalLabel =
    perspective === "borrower" ? t("Vous payez") : t("Prix payé par l’emprunteur");

  return (
    <section aria-label={t("Décomposition du prix")} className={`min-w-0 rounded-xl border border-border bg-surface/50 p-5 wrap-anywhere ${className}`}>
      <dl className="space-y-2 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <dt className="text-muted">
            {providerLabel}
            {providerDetail && <span className="ml-1 text-xs">({providerDetail})</span>}
          </dt>
          <dd className="ml-auto text-right font-mono tabular-nums text-foreground">{show(ok ? breakdown.provider : null)}</dd>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <dt className="text-muted">{t("Frais de calcul (enclave Phala)")}</dt>
          <dd className="ml-auto text-right font-mono tabular-nums text-foreground">{show(ok ? breakdown.compute : null)}</dd>
        </div>
        {withApi && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <dt className="text-muted">
              {t("Accès API inclus")}
              {apiPerDay !== null && <span className="ml-1 text-xs">({t("{days} j × {price} par jour", { days, price: show(apiPerDay) })})</span>}
            </dt>
            <dd className="ml-auto text-right font-mono tabular-nums text-foreground">{show(ok ? breakdown.apiAccess : null)}</dd>
          </div>
        )}
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-border pt-2">
          <dt className="font-medium text-foreground">{totalLabel}</dt>
          <dd className="ml-auto text-right font-mono font-semibold tabular-nums text-foreground">{show(ok ? breakdown.total : null)}</dd>
        </div>
      </dl>
      {ok && breakdown.minimum !== null && (
        <p className={`mt-3 text-xs ${breakdown.belowMinimum ? "text-negative" : "text-muted"}`} role={breakdown.belowMinimum ? "alert" : undefined}>
          {breakdown.belowMinimum
            ? t("Sous le minimum imposé par le tarif : {minimum}.", { minimum: show(breakdown.minimum) })
            : t("Minimum imposé par le tarif : {minimum}.", { minimum: show(breakdown.minimum) })}
        </p>
      )}
      {!ok && (
        <p className="mt-3 text-xs text-negative" role="alert">
          {t("Montant indisponible : valeur invalide.")}
        </p>
      )}
    </section>
  );
}
