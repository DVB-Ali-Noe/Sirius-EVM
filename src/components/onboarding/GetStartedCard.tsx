"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { Card } from "@/components/ui/Card";
import { CardTitle } from "@/components/ui/Heading";
import {
  deriveOnboardingProgress,
  showsChecklist,
  type OnboardingLoan,
  type OnboardingStepId,
} from "@/lib/onboarding/steps";
import { resolveClientNetwork } from "@/lib/evm/networks";
import { stepCopy } from "@/lib/onboarding/copy";
import { dismissChecklist, loadChecklistPreference, requestVerification, useOnboardingStore } from "./onboarding-store";

/** Textes des étapes pour le réseau du site (inliné au build) : pas de « mainnet » sur le testnet. */
const STEP_COPY = stepCopy(resolveClientNetwork());

const PRIMARY ="inline-flex rounded-lg bg-accent px-3.5 py-2 text-xs font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50";

interface GetStartedCardProps {
  address: string;
  /** Soldes lus par le tableau de bord : `null` tant qu'ils sont inconnus. */
  gasWei: string | null;
  stableAtomic: string | null;
  /** Libellé du jeton de règlement, déjà traduit (USDG sur mainnet). */
  token: string;
  /** Ouvre le parcours « Ajouter des fonds » existant du tableau de bord. */
  onAddFunds: () => void;
  fundsPending: boolean;
}

/**
 * Carte « Get started » du tableau de bord : les cinq étapes d'un premier entraînement, cochées
 * d'après l'état réel du compte (registre KYB, soldes, prêts), chacune avec son action. Seule
 * l'étape suivante porte le bouton principal. Masquable ; la fermeture est enregistrée dans le
 * profil et la carte revient depuis « Get started » du menu profil.
 */
export function GetStartedCard({ address, gasWei, stableAtomic, token, onAddFunds, fundsPending }: GetStartedCardProps) {
  const { t } = useLocale();
  const owner = useOnboardingStore((s) => s.owner);
  const kyb = useOnboardingStore((s) => s.kyb);
  const instantAccess = useOnboardingStore((s) => s.instantAccess);
  const dismissed = useOnboardingStore((s) => s.dismissed);
  const reopened = useOnboardingStore((s) => s.reopened);
  const [loans, setLoans] = useState<{ address: string; list: OnboardingLoan[] } | null>(null);
  const ready = owner === address.toLowerCase();

  useEffect(() => {
    if (!ready) return;
    void loadChecklistPreference();
  }, [ready]);

  // Une vérification réussie (`kyb` change) peut suivre un emprunt repris : on relit les prêts.
  useEffect(() => {
    if (!ready) return;
    let active = true;
    void fetch("/api/loans", { cache: "no-store", credentials: "same-origin" })
      .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
      .then((body) => {
        if (active) setLoans({ address, list: Array.isArray(body) ? (body as OnboardingLoan[]) : [] });
      })
      .catch(() => {
        if (active) setLoans({ address, list: [] });
      });
    return () => {
      active = false;
    };
  }, [ready, address, kyb]);

  // Rien tant que l'état n'est pas lu : une carte qui coche ses étapes une à une désoriente.
  if (!ready || kyb === null || !loans || loans.address !== address) return null;
  const progress = deriveOnboardingProgress({ kyb, gasWei, stableAtomic, loans: loans.list, viewer: address });
  if (!showsChecklist({ dismissed, complete: progress.current === null, reopened })) return null;

  function action(id: OnboardingStepId) {
    switch (id) {
      case "verify":
        if (kyb === "unknown") {
          return <Link href="/kyb" className={PRIMARY}>{t("Voir mon statut KYB")}</Link>;
        }
        return (
          <button type="button" onClick={() => void requestVerification("checklist")} aria-haspopup="dialog" className={PRIMARY} data-testid="get-started-verify">
            {instantAccess ? t("Obtenir l’accès instantané") : t("Saisir un code d’invitation")}
          </button>
        );
      case "fund":
        return (
          <button type="button" onClick={onAddFunds} disabled={fundsPending} className={PRIMARY}>
            {fundsPending ? t("Envoi en cours…") : t("Ajouter des fonds")}
          </button>
        );
      case "pick":
      case "borrow":
        return <Link href="/marketplace" className={PRIMARY}>{t("Ouvrir la marketplace")}</Link>;
      case "model":
        return <Link href="/train" className={PRIMARY}>{t("Ouvrir Entraîner")}</Link>;
    }
  }

  const missing = [
    progress.funding.gas ? t("de l’ETH pour le gas") : null,
    progress.funding.token ? t("des {token} pour emprunter", { token }) : null,
  ].filter((item): item is string => item !== null);

  return (
    <Card data-testid="get-started" aria-labelledby="get-started-title" role="region">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle id="get-started-title">{t("Bien démarrer")}</CardTitle>
          <p className="mt-1 text-xs text-muted">
            {progress.current === null
              ? t("Tout est fait : tu as vérifié ton wallet, emprunté un dataset et récupéré un modèle.")
              : t("{done} étapes sur {total} — de ton wallet à ton premier modèle entraîné.", { done: progress.completed, total: progress.total })}
          </p>
        </div>
        <button
          type="button"
          onClick={dismissChecklist}
          className="rounded-lg px-2 py-1 text-xs text-muted transition-colors hover:text-foreground"
        >
          {t("Masquer")}
        </button>
      </div>

      <div
        className="mt-3 h-1 overflow-hidden rounded-full bg-border"
        role="progressbar"
        aria-label={t("Progression")}
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.completed}
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${(progress.completed / progress.total) * 100}%` }} />
      </div>

      <ol className="mt-4 space-y-2">
        {progress.steps.map((step, index) => {
          const current = step.id === progress.current;
          const copy = STEP_COPY[step.id];
          return (
            <li
              key={step.id}
              data-step={step.id}
              data-done={step.done}
              aria-current={current ? "step" : undefined}
              className={`flex gap-3 rounded-xl border p-3 ${current ? "border-accent/40 bg-background/40" : "border-transparent"}`}
            >
              <span
                aria-hidden
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium ${
                  step.done ? "border-positive/50 bg-positive/10 text-positive" : current ? "border-accent text-foreground" : "border-border text-muted"
                }`}
              >
                {step.done ? "✓" : index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium ${step.done ? "text-muted" : "text-foreground"}`}>
                  {t(copy.title, { token })}
                  <span className="sr-only">{step.done ? ` — ${t("fait")}` : ""}</span>
                </p>
                {!step.done && <p className="mt-0.5 text-xs leading-relaxed text-muted">{t(copy.body, { token })}</p>}
                {current && step.id === "fund" && missing.length > 0 && (
                  <p className="mt-1 text-xs text-negative">{t("Il te manque : {items}.", { items: missing.join(t(" et ")) })}</p>
                )}
                {current && <div className="mt-2.5">{action(step.id)}</div>}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
