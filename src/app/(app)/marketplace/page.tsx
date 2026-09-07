"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatBytes } from "@/lib/format";
import { formatUsdcAtomic } from "@/lib/evm/usdc";
import { messageOf } from "@/lib/errors-client";
import { borrowDataset } from "@/lib/loans/client";
import { useFavoritesStore } from "@/stores/favorites";
import { useWalletStore } from "@/stores/wallet";
import { acceptKybCredential } from "@/lib/kyb/client";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { modelDisplayName, modelSelection, type ModelId } from "@/lib/models/registry";

/** Statuts pendant lesquels des fonds sont déjà engagés sur ce dataset. */
const LOAN_EN_COURS = new Set(["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING"]);

interface ActiveLoan {
  datasetId: string;
  borrower: string;
  status: string;
}

interface Dataset {
  id: string;
  name: string;
  description: string | null;
  status: string;
  sizeBytes: number | null;
  priceUsdcAtomic: string | null;
  challengeDays: number;
  metrics: { rowCount: number; columnCount: number } | null;
  modelId: ModelId | null;
  modelVersion: string | null;
  providerReputation?: {
    score: number;
    completedLoans: number;
    cancelledEscrows: number;
  };
}

export default function MarketplacePage() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // `null` tant qu'on ne sait pas : on n'affiche alors rien plutôt qu'un bouton qui
  // clignoterait à chaque chargement pour disparaître aussitôt.
  const [kybManquant, setKybManquant] = useState<boolean | null>(null);
  const favIds = useFavoritesStore((s) => s.ids);
  const address = useWalletStore((s) => s.address);
  const { t } = useLocale();

  const loadPage = useCallback(async (cursor: string | null, append: boolean) => {
    const query = new URLSearchParams({ status: "LISTED" });
    if (cursor) query.set("cursor", cursor);
    const res = await fetch(`/api/datasets?${query}`);
    if (!res.ok) {
      setError(t("Catalogue indisponible"));
      return;
    }
    const page = await res.json() as Dataset[];
    setDatasets((current) => append ? [...current, ...page] : page);
    setNextCursor(res.headers.get("x-sirius-next-cursor"));
  }, [t]);

  const refresh = useCallback(() => loadPage(null, false), [loadPage]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      await loadPage(nextCursor, true);
    } finally {
      setLoadingMore(false);
    }
  }

  // Favoris en premier (ordre stable pour le reste).
  const sorted = [...datasets].sort(
    (a, b) => Number(favIds.includes(b.id)) - Number(favIds.includes(a.id)),
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch initial, setState post-await
    refresh();
  }, [refresh]);

  // Datasets sur lesquels ce compte a déjà un prêt en cours. Emprunter deux fois le même
  // dataset est légitime — on ne le bloque pas — mais rien ne distinguait l'intention du
  // double-clic, et un second escrow se serait ouvert en silence.
  const [datasetsDejaEmpruntes, setDatasetsDejaEmpruntes] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!address) return;
    let actif = true;
    void fetch("/api/loans")
      .then((r) => (r.ok ? (r.json() as Promise<ActiveLoan[]>) : null))
      .then((prets) => {
        if (!actif || !prets) return;
        setDatasetsDejaEmpruntes(
          new Set(
            prets
              .filter((pret) => pret.borrower === address && LOAN_EN_COURS.has(pret.status))
              .map((pret) => pret.datasetId),
          ),
        );
      })
      .catch(() => {});
    return () => {
      actif = false;
    };
  }, [address, datasets]);

  // L'attestation est posée automatiquement à la connexion. Ce bouton n'est donc
  // qu'un secours : il n'apparaît que si elle manque encore, ce qui n'arrive qu'en
  // cas d'échec de ce chemin-là.
  useEffect(() => {
    if (!address) return;
    let actif = true;
    void fetch(`/api/account/status?address=${encodeURIComponent(address)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ known?: unknown }>) : null))
      .then((corps) => {
        if (actif && corps) setKybManquant(corps.known !== true);
      })
      .catch(() => {});
    return () => {
      actif = false;
    };
  }, [address]);

  async function handleOnboard() {
    setError(null);
    try {
      await acceptKybCredential("borrower");
      setKybManquant(false);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 flex-1 basis-64">
            <h1 className="text-2xl font-semibold tracking-tight">{t("Datasets disponibles")}</h1>
            <p className="mt-1 text-sm text-muted">
              {t("Emprunte l’accès via un escrow conditionnel. La donnée reste chiffrée — tu ne récupères qu’un modèle entraîné en TEE.")}
            </p>
          </div>
          {kybManquant === true && (
            <button
              onClick={handleOnboard}
              className="shrink-0 rounded-xl border border-border bg-surface px-3 py-2 text-xs font-medium text-muted transition-colors hover:border-white/20"
            >
              {t("Configurer le KYB")}
            </button>
          )}
        </div>

        {error && (
          <div className="mb-6 rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">
            {t(error)}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
          {datasets.length === 0 && (
            <p className="col-span-full py-8 text-center text-sm text-muted">
              {t("Aucun dataset listé pour l’instant.")}
            </p>
          )}
          {sorted.map((d) => (
            <MarketCard
              key={d.id}
              dataset={d}
              dejaEmprunte={Boolean(address) && datasetsDejaEmpruntes.has(d.id)}
              onBorrowed={refresh}
              onError={setError}
            />
          ))}
        </div>
        {nextCursor && (
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="mx-auto mt-6 block rounded-xl border border-border bg-surface px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-white/20 disabled:opacity-50"
          >
            {loadingMore ? t("Chargement…") : t("Afficher plus")}
          </button>
        )}
    </main>
  );
}

function MarketCard({
  dataset,
  dejaEmprunte,
  onBorrowed,
  onError,
}: {
  dataset: Dataset;
  dejaEmprunte: boolean;
  onBorrowed: () => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const model = modelSelection(dataset.modelId, dataset.modelVersion);
  const isFav = useFavoritesStore((s) => s.ids.includes(dataset.id));
  const toggleFav = useFavoritesStore((s) => s.toggle);

  async function borrow() {
    onError("");
    if (!model) {
      onError(t("Profil d’entraînement du dataset absent ou invalide"));
      return;
    }
    if (
      dejaEmprunte &&
      !window.confirm(
        t("Tu as déjà un emprunt en cours sur ce dataset. En ouvrir un second bloquera {price} USDC de plus. Continuer ?", {
          price: dataset.priceUsdcAtomic ? formatUsdcAtomic(dataset.priceUsdcAtomic) : "?",
        }),
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await borrowDataset({ datasetId: dataset.id });
      onBorrowed();
    } catch (err) {
      onError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 font-medium">{dataset.name}</h3>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => toggleFav(dataset.id)}
            aria-label={isFav ? t("Retirer des favoris") : t("Ajouter aux favoris")}
            aria-pressed={isFav}
            className={`text-lg leading-none transition-colors ${
              isFav ? "text-foreground" : "text-muted-foreground hover:text-muted"
            }`}
          >
            {isFav ? "★" : "☆"}
          </button>
          <Badge variant="positive">{t("LISTED")}</Badge>
        </div>
      </div>
      <Badge className="self-start" variant={model ? "default" : "negative"}>{model ? modelDisplayName(model) : t("Profil absent")}</Badge>
      {dataset.description && <p className="text-sm text-muted">{dataset.description}</p>}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span>{t("{count} lignes", { count: dataset.metrics?.rowCount ?? "—" })}</span>
        <span>{t("{count} colonnes", { count: dataset.metrics?.columnCount ?? "—" })}</span>
        <span>{formatBytes(dataset.sizeBytes)}</span>
      </div>

      <p className="text-sm font-medium">
        {dataset.priceUsdcAtomic ? formatUsdcAtomic(dataset.priceUsdcAtomic) : "—"} USDC
        <span className="ml-2 text-xs font-normal text-muted">{t("remboursable après {days} j", { days: dataset.challengeDays })}</span>
      </p>

      <p className="font-mono text-[11px] uppercase tracking-wider text-muted">
        {t("Confiance EVM {score}/100 · {count} règlements", { score: dataset.providerReputation?.score ?? 0, count: dataset.providerReputation?.completedLoans ?? 0 })}
      </p>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-1">
        <p className="min-w-0 flex-1 basis-40 text-xs text-muted">
          {model ? t("Profil du dataset verrouillé") : t("Profil d’entraînement manquant")}
        </p>
        <button
          onClick={borrow}
          disabled={!model || busy}
          title={!model ? t("Réimporte ce dataset avec un profil d’entraînement") : undefined}
          className="max-w-full shrink-0 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
        >
          {busy ? t("Escrow…") : t("Emprunter")}
        </button>
      </div>
    </Card>
  );
}
