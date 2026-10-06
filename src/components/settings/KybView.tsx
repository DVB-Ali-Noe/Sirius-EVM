"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { KybInviteForm } from "@/components/kyb/KybInviteForm";
import { Card } from "@/components/ui/Card";
import { ConnectPrompt } from "@/components/wallet/ConnectCta";
import { Page, PageHeader } from "@/components/layout/Page";
import { SectionTitle } from "@/components/ui/Heading";
import { useWalletStore } from "@/stores/wallet";
import { SoonItem } from "./SoonItem";
import {
  formatKybDate,
  parsePublicKybStatus,
  parseKybStatus,
  showsInvitationForm,
  type KybView as KybState,
} from "./kyb-state";
import { KYB_CONTACT_EMAIL, KYB_SOON } from "./settings-logic";

/** Page /kyb : état KYB du wallet (lu sur le contrat), invitation et fonctions à venir. */
export function KybView() {
  const { t } = useLocale();
  const connected = useWalletStore((s) => s.connected);
  const address = useWalletStore((s) => s.address);
  const authenticated = useWalletStore((s) => s.authenticated);

  return (
    <Page width="wide">
      <PageHeader
        title={t("KYB")}
        description={t("Business verification, recorded on-chain. It is required to lend and to borrow datasets on mainnet.")}
      />

      {connected && address ? (
        // `key` : un autre wallet ou une session ouverte repart d'un état vierge, sans reste de l'ancien.
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <KybStatusCard key={`${address}:${authenticated}`} address={address} authenticated={authenticated} />
        </div>
      ) : (
        <ConnectPrompt message={t("Connecte un wallet pour voir ton statut KYB.")} data-testid="kyb-signed-out" />
      )}

      <section aria-labelledby="kyb-soon">
        <SectionTitle id="kyb-soon" className="mb-3">{t("Coming soon")}</SectionTitle>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {KYB_SOON.map((item) => <SoonItem key={item.title} {...item} />)}
        </ul>
      </section>
    </Page>
  );
}

function KybStatusCard({ address, authenticated }: { address: string; authenticated: boolean }) {
  const { t, locale } = useLocale();
  const [view, setView] = useState<KybState | null>(null);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async (): Promise<KybState> => {
    try {
      // Avec une session : état complet, date d'expiration comprise. Sans : « attesté ou non » seulement.
      const response = authenticated
        ? await fetch("/api/kyb/status", { cache: "no-store" })
        : await fetch(`/api/account/status?address=${encodeURIComponent(address)}`, { cache: "no-store" });
      if (!response.ok) return { state: "unknown" };
      const body: unknown = await response.json();
      return authenticated ? parseKybStatus(body) : parsePublicKybStatus(body);
    } catch {
      return { state: "unknown" };
    }
  }, [address, authenticated]);

  useEffect(() => {
    let cancelled = false;
    void load().then((next) => {
      if (!cancelled) setView(next);
    });
    return () => {
      cancelled = true;
    };
  }, [load, attempt]);

  const refresh = () => {
    setView(null);
    setAttempt((value) => value + 1);
  };

  if (!view) {
    return (
      <Card data-testid="kyb-loading">
        <p className="text-sm text-muted">{t("Checking your KYB status…")}</p>
      </Card>
    );
  }

  const date = "expiresAt" in view && view.expiresAt ? formatKybDate(view.expiresAt, locale === "fr" ? "fr-FR" : "en-US") : null;

  return (
    <>
      <Card data-testid="kyb-status" data-state={view.state}>
        <SectionTitle>{t("Status")}</SectionTitle>
        {view.state === "verified" && (
          <>
            <p className="mt-2 text-sm font-medium text-positive">{t("Verified")}</p>
            {date && <p className="mt-1 text-xs text-muted" data-testid="kyb-expiry">{t("Attestation valid until {date} (UTC).", { date })}</p>}
          </>
        )}
        {view.state === "expired" && (
          <>
            <p className="mt-2 text-sm font-medium text-negative">{t("Not verified")}</p>
            <p className="mt-1 text-xs text-muted">{date ? t("Your attestation expired on {date} (UTC). Ask for a new invitation.", { date }) : t("Your attestation has expired. Ask for a new invitation.")}</p>
          </>
        )}
        {view.state === "revoked" && (
          <>
            <p className="mt-2 text-sm font-medium text-negative">{t("Not verified")}</p>
            <p className="mt-1 text-xs text-muted">{t("Your attestation was revoked. Contact the Sirius team.")}</p>
          </>
        )}
        {view.state === "inactive" && (
          <>
            <p className="mt-2 text-sm font-medium text-negative">{t("Not verified")}</p>
            <p className="mt-1 text-xs text-muted">{t("Your attestation is no longer accepted by the registry. Ask for a new invitation.")}</p>
          </>
        )}
        {view.state === "none" && <p className="mt-2 text-sm font-medium text-negative">{t("Not verified")}</p>}
        {view.state === "unknown" && (
          <>
            <p className="mt-2 text-sm font-medium">{t("Status unavailable")}</p>
            <p className="mt-1 text-xs text-muted">{t("We could not read your KYB status. This does not mean you are not verified.")}</p>
            <button
              type="button"
              onClick={refresh}
              className="mt-3 rounded-lg border border-border px-3.5 py-2 text-sm font-medium transition-colors hover:border-white/20"
            >
              {t("Retry")}
            </button>
          </>
        )}
        {view.state !== "unknown" && (
          <p className="mt-3 text-xs text-muted">{t("The status is read from the KYB registry contract.")}</p>
        )}
      </Card>

      {showsInvitationForm(view) && (
        <Card className="flex flex-col gap-3" aria-labelledby="kyb-invite" role="region">
          <SectionTitle id="kyb-invite">{t("Invitation")}</SectionTitle>
          {authenticated ? (
            <KybInviteForm role="provider" onAccepted={refresh} />
          ) : (
            <p className="text-sm text-muted">{t("Sign in with your wallet to accept an invitation.")}</p>
          )}
          <p className="text-sm text-muted" data-testid="kyb-contact">
            {t("No invitation? Write to us:")}{" "}
            <a href={`mailto:${KYB_CONTACT_EMAIL}`} className="font-medium text-accent underline-offset-2 hover:underline">{KYB_CONTACT_EMAIL}</a>
          </p>
        </Card>
      )}
    </>
  );
}
