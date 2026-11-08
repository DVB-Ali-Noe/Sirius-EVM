"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { API_KEY_MAX_PER_LOAN } from "@/lib/billing/api-pricing";
import type { ComputeQuote } from "@/lib/billing/quote";
import { messageOf } from "@/lib/errors-client";
import { listApiKeys, revokeApiKey, type ApiKeysOverview } from "@/lib/train/api-keys-client";
import { retryWhileEnclaveStarts } from "@/lib/train/enclave-wait";
import { BuyCallsPanel, type PendingCallPack } from "./BuyCallsPanel";
import { CreateApiKeyDialog } from "./CreateApiKeyDialog";
import { EnclaveStartingSteps } from "./EnclaveStartingSteps";

/** Relecture de l'état de l'enclave tant qu'elle n'est pas prête (onglet visible seulement). */
const ENCLAVE_POLL_MS = 30_000;

/**
 * Panneau API d'un prêt réglé (D-30) : clés (création, révocation), usage indicatif, achat
 * d'appels et état de l'enclave. Jamais pour la régression linéaire : quelques appels suffiraient
 * à reconstruire le modèle (D-27), d'où le texte d'indisponibilité à la place du panneau.
 */
export function ApiPanel({
  loanId,
  datasetId,
  modelId,
  apiEnabled,
  callsPerDay,
  priceUsdcAtomic,
  packsClosed = false,
  money,
  confirmQuote,
  pendingPacks,
  onPurchased,
}: {
  loanId: string;
  datasetId: string;
  modelId: string;
  apiEnabled: boolean;
  callsPerDay: number | null;
  priceUsdcAtomic: string | null | undefined;
  /** Moins d'une heure de location : un pack ne servirait presque pas (refusé par le runner). */
  packsClosed?: boolean;
  money: (atomic: string) => string;
  confirmQuote: (quote: ComputeQuote) => Promise<boolean>;
  pendingPacks: readonly PendingCallPack[];
  onPurchased: () => Promise<void>;
}) {
  const { t } = useLocale();
  if (modelId === "linear_regression") {
    return (
      <p className="mt-3 rounded-lg border border-border bg-surface/30 p-3 text-xs text-muted" data-testid="api-unavailable-linear">
        {t("API indisponible pour la régression linéaire (le modèle serait reconstructible).")}
      </p>
    );
  }
  if (!apiEnabled || !callsPerDay) return null;
  return (
    <ApiPanelContent
      loanId={loanId}
      datasetId={datasetId}
      callsPerDay={callsPerDay}
      priceUsdcAtomic={priceUsdcAtomic}
      packsClosed={packsClosed}
      money={money}
      confirmQuote={confirmQuote}
      pendingPacks={pendingPacks}
      onPurchased={onPurchased}
    />
  );
}

function ApiPanelContent({
  loanId,
  datasetId,
  callsPerDay,
  priceUsdcAtomic,
  packsClosed,
  money,
  confirmQuote,
  pendingPacks,
  onPurchased,
}: {
  loanId: string;
  datasetId: string;
  callsPerDay: number;
  priceUsdcAtomic: string | null | undefined;
  packsClosed: boolean;
  money: (atomic: string) => string;
  confirmQuote: (quote: ComputeQuote) => Promise<boolean>;
  pendingPacks: readonly PendingCallPack[];
  onPurchased: () => Promise<void>;
}) {
  const { locale, t } = useLocale();
  const dateLocale = locale === "fr" ? "fr-FR" : "en-US";
  const [overview, setOverview] = useState<ApiKeysOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeRetry, setRevokeRetry] = useState<number | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await listApiKeys(loanId, signal);
      if (signal?.aborted) return;
      setOverview(next);
      setLoadError(null);
    } catch (error) {
      if (!signal?.aborted) setLoadError(messageOf(error));
    }
  }, [loanId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [load]);

  const enclave = overview?.enclave ?? "running";
  useEffect(() => {
    if (enclave === "running") return;
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, ENCLAVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enclave, load]);

  async function revoke(keyId: string) {
    setActionError(null);
    setRevoking(keyId);
    try {
      // Révoquer passe par l'enclave : si elle démarre, la demande est relancée (sans risque, idempotente).
      await retryWhileEnclaveStarts(() => revokeApiKey({ loanId, keyId }), { onWaiting: setRevokeRetry });
      setConfirmRevoke(null);
      await load();
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setRevoking(null);
    }
  }

  const date = (iso: string) => new Date(iso).toLocaleString(dateLocale, { dateStyle: "medium", timeStyle: "short" });
  const active = overview?.keys.filter((key) => !key.revokedAt) ?? [];
  const limitReached = active.length >= API_KEY_MAX_PER_LOAN;

  return (
    <section className="mt-4 rounded-lg border border-accent/30 bg-accent/5 p-3" data-testid="api-panel" aria-label={t("API développeurs")}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wider text-accent">{t("API développeurs")}</div>
        <Link href="/docs/api" className="text-xs text-muted underline underline-offset-2 hover:text-foreground">
          {t("Documentation de l’API")}
        </Link>
      </div>
      <p className="text-xs text-muted">
        {t("Appelle ce modèle depuis ton code avec une clé signée. Le quota de {calls} appels par jour est commun au site et à l’API ; les appels achetés prennent le relais une fois le quota du jour épuisé.", { calls: callsPerDay })}
      </p>

      {loadError && <p role="alert" className="mt-2 text-xs text-negative">{t(loadError)}</p>}
      {actionError && <p role="alert" className="mt-2 text-xs text-negative">{t(actionError)}</p>}

      {overview && (
        <>
          {enclave === "starting" ? (
            <EnclaveStartingSteps
              phase={enclave}
              closeNote={t("Tu peux fermer cette page : tes appels reçoivent « 503 enclave_starting » avec un délai Retry-After, et le SDK réessaie seul.")}
            />
          ) : enclave === "stopped" ? (
            <p className="mt-2 text-xs text-muted" data-testid="enclave-stopped">
              {active.length > 0
                ? t("L’enclave est arrêtée faute d’usage. Le premier appel API la redémarre : il reçoit « 503 enclave_starting » avec un délai Retry-After (environ 2 min), et le SDK réessaie seul.")
                : t("L’enclave est arrêtée faute d’usage. Elle démarre à la création d’une clé ou à la prochaine prédiction.")}
            </p>
          ) : enclave === "stopping" ? (
            <p className="mt-2 text-xs text-muted" data-testid="enclave-stopping">{t("L’enclave s’arrête faute d’usage. Elle redémarrera à la prochaine demande.")}</p>
          ) : null}

          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs" data-testid="api-usage">
            <div>
              <dt className="text-muted">{t("Appels API aujourd’hui (indicatif)")}</dt>
              <dd className="font-mono">{overview.usage.apiCallsToday} / {overview.callsPerDay}</dd>
            </div>
            <div>
              <dt className="text-muted">{t("Appels achetés (packs réglés)")}</dt>
              <dd className="font-mono">{overview.usage.creditsPurchased}</dd>
            </div>
          </dl>
          <p className="mt-1 text-[11px] text-muted">{t("Le compteur qui fait foi est dans l’enclave : chaque réponse de l’API indique le quota du jour et les crédits restants.")}</p>

          {revokeRetry !== null && (
            <EnclaveStartingSteps
              phase="starting"
              retryInSeconds={revokeRetry}
              testId="revoke-enclave-starting"
              closeNote={t("Garde cette page ouverte jusqu’à la révocation : tant qu’elle n’est pas confirmée, la clé reste active.")}
            />
          )}
          <div className="mt-3 overflow-hidden rounded-lg border border-border" data-testid="api-keys">
            {overview.keys.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted">{t("Aucune clé API pour ce prêt.")}</p>
            ) : overview.keys.map((key) => (
              <div key={key.keyId} data-testid="api-key-row" data-key-id={key.keyId} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2 text-xs last:border-b-0">
                <div className="min-w-0">
                  <p className="font-medium text-foreground">{key.name}</p>
                  <p className="text-muted">
                    {t("Créée le {date}", { date: date(key.createdAt) })}
                    {" · "}
                    {key.lastUsedAt ? t("Dernière utilisation : {date}", { date: date(key.lastUsedAt) }) : t("Jamais utilisée")}
                    {" · "}
                    {t("{count} appels sur 30 jours", { count: key.calls30d })}
                  </p>
                  <p className="font-mono text-[11px] text-muted">sk_live_{key.keyId}.…</p>
                </div>
                {key.revokedAt ? (
                  <span className="text-negative">{t("Révoquée le {date}", { date: date(key.revokedAt) })}</span>
                ) : confirmRevoke === key.keyId ? (
                  <span className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void revoke(key.keyId)}
                      disabled={revoking === key.keyId}
                      className="rounded-lg border border-negative/40 px-3 py-1 font-medium text-negative disabled:opacity-50"
                    >
                      {revoking === key.keyId ? t("Révocation…") : t("Confirmer la révocation")}
                    </button>
                    <button type="button" onClick={() => setConfirmRevoke(null)} disabled={revoking === key.keyId} className="px-2 py-1 text-muted">{t("Annuler")}</button>
                  </span>
                ) : (
                  <button type="button" onClick={() => setConfirmRevoke(key.keyId)} className="rounded-lg border border-negative/40 px-3 py-1 font-medium text-negative">
                    {t("Révoquer")}
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => setCreating(true)}
              disabled={limitReached}
              className="rounded-lg border border-accent/40 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:border-accent disabled:opacity-50"
            >
              {t("Créer une clé API")}
            </button>
            {limitReached && <span className="text-xs text-muted">{t("{count} clés actives au maximum : révoque une clé pour en créer une autre.", { count: API_KEY_MAX_PER_LOAN })}</span>}
          </div>
          <CreateApiKeyDialog
            open={creating}
            loanId={loanId}
            onClose={() => setCreating(false)}
            onCreated={() => void load()}
          />
        </>
      )}

      {packsClosed ? (
        <p className="mt-3 text-xs text-muted" data-testid="packs-closed">
          {t("Moins d’une heure de location restante : prolonge avant d’acheter des appels")}
        </p>
      ) : (
        <BuyCallsPanel
          loanId={loanId}
          datasetId={datasetId}
          priceUsdcAtomic={priceUsdcAtomic}
          callsPerDay={callsPerDay}
          money={money}
          confirmQuote={confirmQuote}
          pendingPacks={pendingPacks}
          onPurchased={async () => { await onPurchased(); await load(); }}
        />
      )}
    </section>
  );
}
