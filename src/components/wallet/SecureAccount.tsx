"use client";

import { useCallback, useState } from "react";
import { useWalletStore } from "@/stores/wallet";
import { secureEmbeddedAccount, getEmbeddedMfaEnabled } from "@/lib/web3auth/manager";
import { useLocale } from "@/components/i18n/LocaleProvider";

/**
 * Sécurisation du wallet embarqué (Web3Auth) : ouvre le flow d'ajout/gestion d'un
 * facteur de récupération et rafraîchit l'état MFA du store au retour. Ne concerne
 * que la source "embedded" (les wallets externes gèrent leur propre custody).
 */
export function useSecureAccount() {
  const source = useWalletStore((s) => s.source);
  const connected = useWalletStore((s) => s.connected);
  const mfaEnabled = useWalletStore((s) => s.mfaEnabled);
  const setMfaEnabled = useWalletStore((s) => s.setMfaEnabled);
  const [pending, setPending] = useState(false);

  const secure = useCallback(async () => {
    setPending(true);
    try {
      await secureEmbeddedAccount();
      setMfaEnabled(await getEmbeddedMfaEnabled());
    } catch (err) {
      // Souvent une annulation utilisateur (popup fermée), parfois un échec technique :
      // on logue pour l'observabilité sans bloquer l'UI (l'état MFA n'est pas touché).
      console.error("Sécurisation du compte échouée", err);
    } finally {
      setPending(false);
    }
  }, [setMfaEnabled]);

  return { isEmbedded: source === "embedded" && connected, mfaEnabled, pending, secure };
}

function ShieldIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={className} aria-hidden>
      <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" strokeLinejoin="round" />
      <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Bandeau de rappel (nudge) : incite à sécuriser un compte embarqué sans facteur de récupération. */
export function SecureAccountBanner() {
  const { isEmbedded, mfaEnabled, pending, secure } = useSecureAccount();
  const { t } = useLocale();
  const [dismissed, setDismissed] = useState(false);

  if (!isEmbedded || mfaEnabled || dismissed) return null;

  return (
    <div className="mx-auto flex max-w-4xl items-center gap-3 px-6 pt-6">
      <div className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
        <ShieldIcon className="h-5 w-5 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{t("Sécurise l’accès à tes fonds")}</p>
          <p className="text-xs text-muted">
            {t("Ajoute un facteur de récupération pour ne pas dépendre du seul login Google.")}
          </p>
        </div>
        <button
          onClick={secure}
          disabled={pending}
          className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
        >
          {pending ? t("Ouverture…") : t("Sécuriser")}
        </button>
        <button
          onClick={() => setDismissed(true)}
          aria-label={t("Ignorer")}
          className="shrink-0 rounded-md p-1 text-muted transition-colors hover:text-foreground"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/** Carte « Sécurité » (page wallet) : état du compte + action sécuriser / gérer les facteurs. */
export function SecureAccountCard() {
  const { isEmbedded, mfaEnabled, pending, secure } = useSecureAccount();
  const { t } = useLocale();

  if (!isEmbedded) return null;

  return (
    <div className="mt-6 rounded-xl border border-border bg-surface/50 p-5">
      <div className="flex items-start gap-3">
        <ShieldIcon className={`h-5 w-5 shrink-0 ${mfaEnabled ? "text-positive" : "text-muted"}`} />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{t("Sécurité du compte")}</h2>
          <p className="mt-1 text-xs text-muted">
            {mfaEnabled
              ? t("Un facteur de récupération est configuré. Tu peux le gérer à tout moment.")
              : t("Ton compte dépend du seul login Google. Ajoute un facteur de récupération (PIN, phrase, authenticator) pour protéger l'accès à tes fonds.")}
          </p>
        </div>
      </div>
      <button
        onClick={secure}
        disabled={pending}
        className="mt-4 rounded-xl border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-white/20 disabled:opacity-50"
      >
        {pending ? t("Ouverture…") : mfaEnabled ? t("Gérer les facteurs") : t("Sécuriser mon compte")}
      </button>
    </div>
  );
}
