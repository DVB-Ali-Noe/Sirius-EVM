"use client";

import { useEffect, useRef, useState } from "react";
import { useWalletStore } from "@/stores/wallet";
import { useLocale } from "@/components/i18n/LocaleProvider";

const SEEN_KEY = "sirius-tour-seen";

export function ProductTour() {
  const connected = useWalletStore((s) => s.connected);
  const address = useWalletStore((s) => s.address);
  const { t } = useLocale();
  const steps = [
    { title: t("Bienvenue sur Sirius"), body: t("Entraîne des modèles sur de la donnée confidentielle, ou monétise la tienne — le tout réglé et audité sur EVM.") },
    { title: t("Entraîner un modèle"), body: t("Choisis un dataset : les tiens (gratuit, sans escrow) ou le catalogue (emprunt via escrow). Le calcul tourne dans un TEE — tu ne récupères que le modèle, jamais la donnée brute.") },
    { title: t("Tes données sont un actif"), body: t("Dépose un dataset : il est chiffré, inscrit sur EVM, et tu gardes le titre et les revenus. La donnée brute ne sort jamais.") },
    { title: t("Ton wallet, tes fonds"), body: t("Solde, ajout par carte (MoonPay) et retrait vers n'importe quelle adresse. Tes fonds vivent on-chain — jamais chez Sirius.") },
  ];

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  // Ne se base PAS sur « déjà tenté pour cette adresse » : en StrictMode (dev), le
  // cleanup annulerait le seul fetch et le tour ne s'ouvrirait jamais. On garde un
  // flag « déjà affiché » posé uniquement au succès.
  const shownRef = useRef(false);

  useEffect(() => {
    if (!connected || !address) return;
    if (shownRef.current) return;
    if (localStorage.getItem(SEEN_KEY)) return;

    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/account/status?address=${address}`);
        if (!res.ok) return;
        const { known } = await res.json();
        if (active && !known && !shownRef.current) {
          shownRef.current = true;
          setStep(0);
          setOpen(true);
        }
      } catch {
        // Détection best-effort : en cas d'échec, pas de tour (non bloquant).
      }
    })();
    return () => {
      active = false;
    };
  }, [connected, address]);

  function finish() {
    localStorage.setItem(SEEN_KEY, "1");
    setOpen(false);
  }

  if (!open) return null;

  const isLast = step === steps.length - 1;
  const current = steps[step];

  return (
    <div data-product-tour className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-xl">
        <div className="text-xs uppercase tracking-wider text-muted">
          {t("Étape {current} / {total}", { current: step + 1, total: steps.length })}
        </div>
        <h2 className="mt-2 text-xl font-semibold tracking-tight">{current.title}</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted">{current.body}</p>

        <div className="mt-5 flex items-center gap-1.5">
          {steps.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? "w-5 bg-foreground" : "w-1.5 bg-border"
              }`}
            />
          ))}
        </div>

        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={finish}
            className="text-sm text-muted transition-colors hover:text-foreground"
          >
            {t("Passer")}
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="rounded-xl border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-white/20"
              >
                {t("Précédent")}
              </button>
            )}
            <button
              onClick={() => (isLast ? finish() : setStep((s) => s + 1))}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90"
            >
              {isLast ? t("Commencer") : t("Suivant")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
