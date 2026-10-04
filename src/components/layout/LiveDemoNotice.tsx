"use client";

import { useEffect, useState } from "react";
import { useWalletStore } from "@/stores/wallet";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { LIVE_DEMO_URL } from "@/lib/phala-demo/live-session";

const DISMISSED_KEY = "sirius-live-demo-dismissed";

function dismissedToday(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === new Date().toISOString().slice(0, 10);
  } catch {
    return false;
  }
}

/**
 * Annonce de la session de training en direct, après connexion. Elle attend que la visite
 * guidée soit fermée, pour ne jamais empiler deux fenêtres.
 */
export function LiveDemoNotice() {
  const connected = useWalletStore((s) => s.connected);
  const { t } = useLocale();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!connected || dismissedToday()) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        const response = await fetch("/api/demo-live", { cache: "no-store" });
        if (!response.ok) return;
        const body = await response.json();
        if (!active || body.open !== true) return;
        const show = () => {
          if (!active) return;
          if (document.querySelector("[data-product-tour]")) timer = setTimeout(show, 1500);
          else setOpen(true);
        };
        show();
      } catch {
        // Annonce facultative : en cas d'erreur, rien ne s'affiche.
      }
    })();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [connected]);

  function dismiss() {
    try {
      localStorage.setItem(DISMISSED_KEY, new Date().toISOString().slice(0, 10));
    } catch {
      // Stockage indisponible : la fenêtre se ferme quand même.
    }
    setOpen(false);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="live-demo-title">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-xl">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-positive">
          <span className="h-2 w-2 animate-pulse rounded-full bg-positive" />
          {t("En direct")}
        </div>
        <h2 id="live-demo-title" className="mt-2 text-xl font-semibold tracking-tight">{t("La session d’entraînement est ouverte")}</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          {t("Entraîne un modèle sur un exemple ou sur ton propre CSV, dans une enclave Phala. C’est gratuit pendant la session.")}
        </p>
        <div className="mt-6 flex items-center justify-between">
          <button onClick={dismiss} className="text-sm text-muted transition-colors hover:text-foreground">
            {t("Plus tard")}
          </button>
          <a
            href={LIVE_DEMO_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={dismiss}
            className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90"
          >
            {t("Essayer maintenant")}
          </a>
        </div>
      </div>
    </div>
  );
}
