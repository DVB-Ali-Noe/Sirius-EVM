"use client";

import { useEffect, useState } from "react";
import { useWalletStore } from "@/stores/wallet";
import { disconnectWallet } from "@/lib/wallet/manager";
import { markWalletDisconnected } from "@/lib/wallet/intent";
import { selectWallet, waitForWallets, type WalletInfo } from "@/lib/wallet/discovery";
import { signInWithWallet, signOut } from "@/lib/auth/client";
import { resolveClientNetwork } from "@/lib/evm/networks";
import { openWalletModal } from "./WalletConnector";
import { useLocale } from "@/components/i18n/LocaleProvider";

function truncate(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const EXPECTED_NETWORK = resolveClientNetwork();

/** dropUp : ouvre le menu vers le haut (footer de sidebar, sinon clippé en bas de viewport). */
export function ConnectButton({ dropUp = false }: { dropUp?: boolean }) {
  const connected = useWalletStore((s) => s.connected);
  const address = useWalletStore((s) => s.address);
  const network = useWalletStore((s) => s.network);
  const authenticated = useWalletStore((s) => s.authenticated);
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [authPending, setAuthPending] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const wrongNetwork = !!network && network !== EXPECTED_NETWORK;
  const menuPos = dropUp ? "bottom-full mb-2" : "mt-2";
  // En sidebar (dropUp) le conteneur est étroit : bouton pleine largeur centré + menu
  // calé sur la largeur du footer (sinon w-64/w-72 déborde de la colonne).
  const triggerFull = dropUp ? "w-full justify-center" : "";
  const menuWidth = dropUp ? "inset-x-0" : "right-0";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const handleSignIn = async () => {
    setAuthPending(true);
    setAuthError(null);
    try {
      await signInWithWallet();
      setOpen(false);
    } catch (error) {
      // Affiché tel quel : c'est le portefeuille qui parle, et lui seul sait
      // pourquoi il a refusé. Un message générique nous a coûté une soirée.
      console.error("[sirius] signature refusée", error);
      setAuthError(error instanceof Error ? error.message : "Échec — réessaie");
    } finally {
      setAuthPending(false);
    }
  };

  // Portefeuilles réellement installés, annoncés via EIP-6963. Interrogés à
  // l'ouverture du menu plutôt qu'au montage : une extension peut s'installer ou se
  // déverrouiller pendant la visite, et la liste doit alors refléter le présent.
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [scanning, setScanning] = useState(false);

  // La recherche part du clic plutôt que d'un effet : c'est une conséquence directe
  // du geste de l'utilisateur, pas une synchronisation avec un état extérieur.
  const toggleMenu = () => {
    const ouvrir = !open;
    setOpen(ouvrir);
    if (!ouvrir || connected) return;
    setScanning(true);
    void waitForWallets()
      .then(setWallets)
      .finally(() => setScanning(false));
  };

  const handleExternal = (rdns?: string) => {
    // Le choix est enregistré avant d'ouvrir la connexion : c'est lui qui décide
    // quel portefeuille recevra la demande, au lieu de laisser `window.ethereum`
    // désigner le gagnant de la course d'injection.
    if (rdns) selectWallet(rdns);
    setOpen(false);
    openWalletModal();
  };

  const handleDisconnect = async () => {
    setOpen(false);
    try {
      // Posée avant toute chose : si la révocation ou la déconnexion de session
      // échoue, le geste de l'utilisateur doit tout de même être respecté.
      markWalletDisconnected();
      await signOut();
      await disconnectWallet();
    } finally {
      useWalletStore.getState().setDisconnected();
    }
  };

  const handleCopyAddress = async () => {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  if (!connected || !address) {
    return (
      <div className="relative">
        <button
          onClick={toggleMenu}
          aria-haspopup="menu"
          aria-expanded={open}
          className={`${dropUp ? "rounded-[2rem]" : "rounded-xl"} bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 ${triggerFull}`}
        >
          {t("Connexion")}
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div role="menu" className={`absolute z-50 ${menuPos} ${menuWidth} ${dropUp ? "rounded-[2rem]" : "w-72 rounded-xl"} overflow-hidden border border-border bg-surface shadow-xl`}>
              <button
                type="button"
                disabled
                className="block w-full cursor-not-allowed px-4 py-3 text-left opacity-60"
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-foreground">{t("Continuer avec Google")}</span>
                  <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">
                    {t("Bientôt disponible")}
                  </span>
                </span>
                <span className="mt-0.5 block text-xs text-muted">{t("Sans crypto, en un clic")}</span>
              </button>
              <div className="border-t border-border" />
              {scanning && wallets.length === 0 && (
                <div className="px-4 py-3 text-xs text-muted">{t("Recherche des wallets…")}</div>
              )}

              {wallets.map((wallet) => (
                <button
                  key={wallet.rdns}
                  onClick={() => handleExternal(wallet.rdns)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5"
                >
                  {wallet.icon && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={wallet.icon} alt="" aria-hidden className="h-6 w-6 shrink-0 rounded-md" />
                  )}
                  <span className="text-sm font-medium text-foreground">{wallet.name}</span>
                </button>
              ))}

              {!scanning && wallets.length === 0 && (
                <button
                  onClick={() => handleExternal()}
                  className="block w-full px-4 py-3 text-left transition-colors hover:bg-white/5"
                >
                  <span className="text-sm font-medium text-foreground">{t("Wallet externe")}</span>
                  <span className="mt-0.5 block text-xs text-muted">Phantom, MetaMask, Rabby, Coinbase Wallet…</span>
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-2 ${dropUp ? "rounded-[2rem]" : "rounded-xl"} border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-white/20 ${triggerFull}`}
      >
        <span className={`h-2 w-2 rounded-full ${wrongNetwork ? "bg-negative" : "bg-positive"}`} />
        <span className="font-mono">{truncate(address)}</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div role="menu" className={`absolute z-50 ${menuPos} ${menuWidth} ${dropUp ? "rounded-[2rem]" : "w-64 rounded-xl"} overflow-hidden border border-border bg-surface shadow-xl`}>
            <button
              type="button"
              onClick={handleCopyAddress}
              className="group flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors hover:bg-white/5"
              aria-label={copied ? t("Adresse copiée") : t("Copier l’adresse")}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-sm text-foreground" title={address}>{address}</span>
                <span
                  className={`mt-1 block text-xs uppercase tracking-wider ${wrongNetwork ? "text-negative" : "text-muted"}`}
                >
                  Robinhood Chain · {network ?? "—"}
                </span>
              </span>
              <span className={`shrink-0 transition-colors ${copied ? "text-positive" : "text-muted group-hover:text-foreground"}`} aria-hidden>
                {copied ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m5 12 4 4L19 6" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </span>
            </button>
            {copied && <p className="px-4 pt-2 text-xs text-positive">{t("Adresse copiée")}</p>}

            {/*
              Certains portefeuilles — Phantom notamment — gardent le choix du compte
              dans leur extension et refusent qu'un site rouvre leur sélecteur. Sans
              cette phrase, l'utilisateur clique « Déconnecter », se reconnecte, retombe
              sur le même compte, et n'a aucun moyen de deviner où le changer.
            */}
            <p className="border-b border-border px-4 py-3 text-xs leading-snug text-muted">
              {t("Pour changer de compte, sélectionne-le directement dans ton wallet — l'application suivra.")}
            </p>
            {wrongNetwork && (
              <div className="px-4 pt-2 text-xs leading-snug text-negative">
                {t("Mauvais réseau — bascule ton wallet sur {network}.", { network: EXPECTED_NETWORK })}
              </div>
            )}
            {authenticated ? (
              <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-xs text-positive">
                <span className="h-1.5 w-1.5 rounded-full bg-positive" />
                {t("Authentifié")}
              </div>
            ) : (
              <button
                onClick={handleSignIn}
                disabled={authPending}
                className="w-full border-b border-border px-4 py-3 text-left transition-colors hover:bg-white/5 disabled:opacity-50"
              >
                <span className="text-sm font-medium text-foreground">
                  {authPending ? t("Signature…") : t("Se connecter")}
                </span>
                <span className="mt-0.5 block text-xs text-muted">
                  {authError ?? t("Signe pour prouver la possession du wallet")}
                </span>
              </button>
            )}
            <button
              onClick={handleDisconnect}
              className="w-full px-4 py-3 text-left text-sm font-medium text-negative transition-colors hover:bg-negative/10"
            >
              {t("Déconnecter")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
