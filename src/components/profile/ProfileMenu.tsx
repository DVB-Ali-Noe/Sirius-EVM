"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { logoutCurrentWallet } from "@/components/wallet/logout";
import { fetchUsdcBalance } from "@/lib/evm/balance";
import { addressExplorerUrl } from "@/lib/evm/explorer";
import { resolveClientNetwork } from "@/lib/evm/networks";
import { formatUsdcAtomic } from "@/lib/evm/usdc";
import { useWalletStore } from "@/stores/wallet";
import { normalizeAddress, shortAddress } from "./address";
import { requestGuidedTour } from "./guided-tour";
import { formatTokenAmount, isWrongNetwork, networkBadge, stablecoinSymbol } from "./network";
import { useCopy } from "./useCopy";

const NETWORK = resolveClientNetwork();

const ITEM_CLASS =
  "flex w-full items-center px-4 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-white/5 focus-visible:bg-white/5 focus-visible:outline-none";

/**
 * Bouton profil, en haut à droite de l'application (docs/passage-mainnet/05-wallet.md).
 *
 * Il n'existe que connecté : la connexion reste portée par le bouton de la barre latérale.
 * Il occupe une ligne alignée à droite en tête du contenu, sur ordinateur comme sur mobile.
 * Une position fixe a été écartée : elle aurait recouvert les actions placées à droite de
 * l'en-tête de plusieurs pages (Marketplace, Mes datasets) entre 768 et 1500 px de large,
 * et la barre du haut du mobile est déjà occupée.
 *
 * Le menu est une fenêtre volante, pas un `role="menu"` : il mêle informations (réseau,
 * solde) et actions, ce que le motif ARIA « menu » ne prévoit pas.
 */
export function ProfileMenu() {
  const connected = useWalletStore((state) => state.connected);
  const address = useWalletStore((state) => state.address);
  const walletNetwork = useWalletStore((state) => state.network);
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const checksummed = connected ? normalizeAddress(address) : null;
  const short = shortAddress(checksummed);
  // Rien à montrer sans adresse valide : la barre latérale garde la connexion et la déconnexion.
  if (!checksummed || !short) {
    // Une déconnexion venue du wallet pendant que le menu est ouvert ne doit pas le rouvrir
    // tout seul à la reconnexion. Ajustement d'état pendant le rendu, motif prévu par React.
    if (open) setOpen(false);
    return null;
  }

  const badge = networkBadge(NETWORK);
  const wrongNetwork = isWrongNetwork(NETWORK, walletNetwork);

  return (
    <div className="flex justify-end px-4 md:px-6">
      <div className="relative">
        <button
          ref={trigger}
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t("Menu du profil")}
          data-testid="profile-button"
          className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:border-white/20"
        >
          <span className={`h-2 w-2 rounded-full ${wrongNetwork ? "bg-negative" : badge.dotClassName}`} aria-hidden />
          <span className="font-mono">{short}</span>
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => close()} aria-hidden />
            <ProfilePanel
              key={checksummed}
              address={checksummed}
              short={short}
              wrongNetwork={wrongNetwork}
              onClose={close}
            />
          </>
        )}
      </div>
    </div>
  );
}

type BalanceState = { status: "loading" } | { status: "ready"; text: string } | { status: "error" };

function ProfilePanel({
  address,
  short,
  wrongNetwork,
  onClose,
}: {
  address: string;
  short: string;
  wrongNetwork: boolean;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const { t } = useLocale();
  const badge = networkBadge(NETWORK);
  const token = t(stablecoinSymbol(NETWORK));
  const { state: copyState, copy } = useCopy();
  const [balance, setBalance] = useState<BalanceState>({ status: "loading" });
  const [tourUnavailable, setTourUnavailable] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // Lu à l'ouverture seulement : pas d'appel RPC tant que le menu reste fermé. Le panneau est
  // remonté (`key`) si l'adresse change, et `cancelled` écarte la réponse d'un compte remplacé.
  useEffect(() => {
    // `eth_call` part sur la chaîne du wallet : sur un autre réseau, il rendrait le solde d'un
    // autre jeton (ou rien) sous l'étiquette du jeton du site. On ne lit donc rien.
    if (wrongNetwork) return;
    let cancelled = false;
    void fetchUsdcBalance(address)
      .then(({ atomic }) => {
        if (cancelled) return;
        const text = formatTokenAmount(formatUsdcAtomic(atomic));
        setBalance(text ? { status: "ready", text } : { status: "error" });
      })
      .catch(() => {
        if (!cancelled) setBalance({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [address, wrongNetwork]);

  const handleTour = () => {
    if (requestGuidedTour()) onClose();
    else setTourUnavailable(true);
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    onClose();
    await logoutCurrentWallet().catch(() => undefined);
  };

  return (
    <div
      role="dialog"
      aria-label={t("Menu du profil")}
      className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
    >
      <div className="border-b border-border px-4 py-3">
        <span
          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge.className}`}
          data-testid="network-badge"
          data-network={badge.network}
        >
          {t(badge.label)}
        </span>
        {wrongNetwork && (
          <p role="alert" className="mt-2 text-xs leading-snug text-negative">
            {t("Mauvais réseau — bascule ton wallet sur {network}.", { network: NETWORK })}
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-sm" title={address} data-testid="profile-address">{short}</span>
          <button
            type="button"
            onClick={() => void copy(address)}
            className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:border-white/20"
          >
            {copyState === "copied" ? t("Adresse copiée") : copyState === "failed" ? t("Copie impossible") : t("Copier l’adresse")}
          </button>
          <a
            href={addressExplorerUrl(NETWORK, address)}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:border-white/20"
          >
            {t("Explorateur")}
          </a>
        </div>
      </div>

      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <span className="text-xs uppercase tracking-wider text-muted">{t("Solde")}</span>
        <span className="text-sm font-medium" data-testid="profile-balance">
          {wrongNetwork
            ? "—"
            : balance.status === "loading" ? "…" : balance.status === "error" ? t("Solde indisponible.") : `${balance.text} ${token}`}
        </span>
      </div>

      <nav className="py-1" aria-label={t("Menu du profil")}>
        <Link href="/wallet" onClick={() => onClose()} className={ITEM_CLASS}>{t("Wallet")}</Link>
        <Link href="/settings" onClick={() => onClose()} className={ITEM_CLASS}>{t("Réglages")}</Link>
        <Link href="/kyb" onClick={() => onClose()} className={ITEM_CLASS}>{t("KYB")}</Link>
        <button type="button" onClick={handleTour} className={ITEM_CLASS}>{t("Visite guidée")}</button>
        {tourUnavailable && (
          <p role="status" className="px-4 pb-2 text-xs text-muted">{t("La visite guidée sera bientôt disponible.")}</p>
        )}
      </nav>

      <button
        type="button"
        onClick={() => void handleLogout()}
        disabled={loggingOut}
        className="w-full border-t border-border px-4 py-3 text-left text-sm font-medium text-negative transition-colors hover:bg-negative/10 disabled:opacity-50"
      >
        {t("Se déconnecter")}
      </button>
    </div>
  );
}
