"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useComputeQuoteConfirmation } from "@/components/loans/ComputeQuoteDialog";
import { KybInviteForm } from "@/components/kyb/KybInviteForm";
import { connectWallet } from "@/components/wallet/WalletConnector";
import { signInWithWallet } from "@/lib/auth/client";
import { messageOf } from "@/lib/errors-client";
import { addressesEqual } from "@/lib/evm/address";
import { acceptKybCredential } from "@/lib/kyb/client";
import { borrowDataset } from "@/lib/loans/client";
import { modelSelection } from "@/lib/models/registry";
import { useWalletStore } from "@/stores/wallet";

/** Statuts pendant lesquels des fonds sont déjà engagés sur ce dataset (repris de l'ancienne grille). */
/** Au-delà du cache de 30 s de `/api/account/status`, pour relire un statut frais. */
const KYB_RECHECK_MS = 31_000;

const LOAN_EN_COURS = new Set(["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING"]);

interface ActiveLoan {
  datasetId: string;
  borrower: string;
  status: string;
}

/**
 * Bouton « Emprunter » de la fiche publique.
 *
 * Le parcours d'emprunt est celui d'avant, inchangé : `borrowDataset` (préparation du prêt,
 * devis signé confirmé par l'emprunteur, approbation puis lock). Seule nouveauté : la fiche se lit
 * sans wallet, et c'est ici, au clic, que la connexion puis la signature sont demandées. Après la
 * signature, l'emprunteur clique à nouveau : l'emprunt ne part jamais tout seul.
 */
export function BorrowPanel({
  datasetId,
  priceUsdcAtomic,
  modelId,
  modelVersion,
  providerVerified,
}: {
  datasetId: string;
  /**
   * Statut KYB du fournisseur lu par la fiche. `false` : l'emprunt serait refusé par le serveur
   * et le contrat (`requireCounterpartyKyb`), le bouton est donc désactivé avant toute signature.
   * `null` (illisible) laisse essayer : le serveur tranche.
   */
  providerVerified: boolean | null;
  priceUsdcAtomic: string;
  modelId: string | null;
  modelVersion: string | null;
}) {
  const { t } = useLocale();
  const address = useWalletStore((s) => s.address);
  const authenticated = useWalletStore((s) => s.authenticated);
  const { confirmQuote, quoteDialog } = useComputeQuoteConfirmation();
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [borrowedCount, setBorrowedCount] = useState(0);
  // Chaque lecture est rangée avec le compte qui l'a faite : après un changement de wallet, la
  // valeur d'un autre compte n'est jamais réutilisée. Le panneau n'est pas remonté à chaque
  // révision du wallet, sinon une connexion en cours perdrait son état et ses erreurs.
  const [kyb, setKyb] = useState<{ session: string; missing: boolean } | null>(null);
  const [loans, setLoans] = useState<{ session: string; active: boolean } | null>(null);
  const [rechecked, setRechecked] = useState<string | null>(null);
  const model = modelSelection(modelId, modelVersion);
  const sessionKey = authenticated && address ? address : null;
  // `null` tant qu'on ne sait pas : rien n'est affiché plutôt qu'un bouton qui clignote.
  const kybManquant = kyb && kyb.session === sessionKey ? kyb.missing : null;
  const dejaEmprunte = Boolean(loans && loans.session === sessionKey && loans.active);

  // Prêt déjà en cours sur ce dataset pour ce compte : emprunter deux fois est légitime, mais
  // on demande confirmation pour distinguer l'intention du double clic.
  useEffect(() => {
    if (!sessionKey) return;
    let actif = true;
    void fetch("/api/loans")
      .then((r) => (r.ok ? (r.json() as Promise<ActiveLoan[]>) : null))
      .then((prets) => {
        if (!actif || !Array.isArray(prets)) return;
        setLoans({
          session: sessionKey,
          active: prets.some((pret) =>
            pret.datasetId === datasetId && addressesEqual(pret.borrower, sessionKey) && LOAN_EN_COURS.has(pret.status)),
        });
      })
      .catch(() => {});
    return () => {
      actif = false;
    };
  }, [sessionKey, datasetId, borrowedCount]);

  // L'attestation KYB est posée juste après la signature ; ce formulaire n'est qu'un secours.
  // Une première lecture « absente » peut précéder la fin de cette attestation automatique :
  // une seule relecture, quelques secondes plus tard, évite d'afficher le secours à tort.
  useEffect(() => {
    if (!sessionKey) return;
    let actif = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void fetch(`/api/account/status?address=${encodeURIComponent(sessionKey)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ known?: unknown }>) : null))
      .then((corps) => {
        if (!actif || !corps) return;
        const missing = corps.known !== true;
        if (missing && rechecked !== sessionKey) {
          timer = setTimeout(() => setRechecked(sessionKey), KYB_RECHECK_MS);
          return;
        }
        setKyb({ session: sessionKey, missing });
      })
      .catch(() => {});
    return () => {
      actif = false;
      if (timer) clearTimeout(timer);
    };
  }, [sessionKey, rechecked]);

  async function signIn() {
    setSigningIn(true);
    try {
      if (!useWalletStore.getState().connected) await connectWallet();
      const { connected, authenticated: signed } = useWalletStore.getState();
      if (connected && !signed) await signInWithWallet();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSigningIn(false);
    }
  }

  async function borrow() {
    setError(null);
    if (!useWalletStore.getState().authenticated) {
      await signIn();
      return;
    }
    if (providerVerified === false) return;
    if (!model || !priceUsdcAtomic) {
      setError("Profil d’entraînement du dataset absent ou invalide");
      return;
    }
    if (dejaEmprunte && !window.confirm(t("Tu as déjà un emprunt en cours sur ce dataset. Préparer un nouvel emprunt ?"))) {
      return;
    }
    setBusy(true);
    try {
      if (await borrowDataset({ datasetId, priceUsdcAtomic, confirmQuote })) setBorrowedCount((count) => count + 1);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleOnboard() {
    setError(null);
    try {
      await acceptKybCredential("borrower");
      if (sessionKey) setKyb({ session: sessionKey, missing: false });
    } catch (err) {
      setError(messageOf(err));
    }
  }

  const showKyb = sessionKey !== null && kybManquant === true;

  return (
    <div className="space-y-3">
      {quoteDialog}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void borrow()}
          disabled={busy || signingIn || !model || !priceUsdcAtomic || providerVerified === false}
          title={!model ? t("Réimporte ce dataset avec un profil d’entraînement") : undefined}
          className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
        >
          {busy ? t("Escrow…") : signingIn ? t("Connexion…") : t("Emprunter")}
        </button>
        {showKyb && (
          <button
            type="button"
            onClick={() => void handleOnboard()}
            className="rounded-xl border border-border bg-surface px-3 py-2 text-xs font-medium text-muted transition-colors hover:border-white/20"
          >
            {t("Configurer le KYB")}
          </button>
        )}
      </div>
      {!authenticated && (
        <p className="text-xs text-muted">
          {t("La consultation est ouverte à tous. Pour emprunter, connectez votre wallet et signez : la connexion est demandée au clic.")}
        </p>
      )}
      {!model && <p className="text-xs text-negative">{t("Profil d’entraînement manquant")}</p>}
      {providerVerified === false && (
        <p className="text-xs text-negative">
          {t("Emprunt indisponible : l’attestation KYB du fournisseur est absente ou expirée.")}
        </p>
      )}
      {showKyb && <KybInviteForm role="borrower" onAccepted={() => sessionKey && setKyb({ session: sessionKey, missing: false })} />}
      {error && (
        <p role="alert" className="rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-sm text-negative">
          {t(error)}
        </p>
      )}
      {borrowedCount > 0 && !error && (
        <p role="status" className="rounded-lg border border-positive/40 bg-positive/10 px-3 py-2 text-sm">
          {t("Emprunt enregistré. Lancez l’entraînement depuis la page")}{" "}
          <Link href="/train" className="font-medium underline underline-offset-2">{t("Entraîner")}</Link>.
        </p>
      )}
    </div>
  );
}
