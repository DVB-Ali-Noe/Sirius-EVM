"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Field } from "@/components/ui/Field";
import { ConnectCta } from "@/components/wallet/ConnectCta";
import { formatBytes, truncate } from "@/lib/format";
import { messageOf } from "@/lib/errors-client";
import { useUiStore } from "@/stores/ui";
import { useWalletStore } from "@/stores/wallet";
import { ModeToggle } from "@/components/ui/ModeToggle";
import {
  destroyDataset,
  publishDataset,
  setDatasetVisibility,
} from "@/lib/datasets/client";
import { acceptKybCredential } from "@/lib/kyb/client";
import { useLocale } from "@/components/i18n/LocaleProvider";

interface DatasetMetrics {
  rowCount: number;
  columnCount: number;
}

type DatasetStatus = "DRAFT" | "LISTING" | "LISTED" | "UNLISTED" | "PRIVATE" | "SUSPENDED" | "DELETED";

interface Dataset {
  id: string;
  name: string;
  description: string | null;
  status: DatasetStatus;
  ipfsCid: string | null;
  merkleRoot: string | null;
  evmDatasetId: string | null;
  sizeBytes: number | null;
  metrics: DatasetMetrics | null;
}

const STATUS_VARIANT: Record<DatasetStatus, BadgeVariant> = {
  DRAFT: "warning",
  LISTING: "warning",
  LISTED: "positive",
  UNLISTED: "accent",
  PRIVATE: "muted",
  SUSPENDED: "negative",
  DELETED: "default",
};

const STATUS_LABEL: Record<DatasetStatus, string> = {
  DRAFT: "Brouillon",
  LISTING: "Publication…",
  LISTED: "Public",
  UNLISTED: "Semi-privé",
  PRIVATE: "Privé",
  SUSPENDED: "Suspendu",
  DELETED: "Supprimé",
};

const VISIBILITY_OPTIONS = [
  { value: "LISTED", label: "Public", hint: "Dans le catalogue, empruntable par tous" },
  { value: "UNLISTED", label: "Semi-privé", hint: "Hors catalogue, empruntable par lien direct" },
  { value: "PRIVATE", label: "Privé", hint: "Toi seul (self-train)" },
] as const;

const VISIBILITY_STATES: DatasetStatus[] = ["LISTED", "UNLISTED", "PRIVATE"];

export default function DatasetsPage() {
  const advanced = useUiStore((s) => s.advanced);
  const connected = useWalletStore((s) => s.connected);
  const address = useWalletStore((s) => s.address);
  const authenticated = useWalletStore((s) => s.authenticated);
  const { t } = useLocale();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Dépend de l'adresse : les datasets sont scopés à l'identité authentifiée
  // (un changement de wallet doit re-fetcher, pas garder l'ancienne liste).
  const loadPage = useCallback(async (cursor: string | null, append: boolean) => {
    if (!address || !authenticated) {
      setDatasets([]);
      setNextCursor(null);
      return;
    }
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const res = await fetch(`/api/datasets${query}`);
    if (!res.ok) return;
    const page = await res.json() as Dataset[];
    setDatasets((current) => append ? [...current, ...page] : page);
    setNextCursor(res.headers.get("x-sirius-next-cursor"));
  }, [address, authenticated]);

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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch initial, setState post-await
    refresh();
  }, [refresh]);

  async function handleList(dataset: Dataset) {
    setError(null);
    setPendingId(dataset.id);
    try {
      await publishDataset(dataset.id);
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPendingId(null);
    }
  }

  async function handleVisibility(id: string, visibility: string) {
    setError(null);
    setPendingId(id);
    try {
      if (!VISIBILITY_STATES.includes(visibility as DatasetStatus)) throw new Error(t("Visibilité invalide"));
      await setDatasetVisibility(id, visibility as "LISTED" | "UNLISTED" | "PRIVATE");
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPendingId(null);
    }
  }

  async function handleDelete(dataset: Dataset) {
    if (
      !window.confirm(
        dataset.status === "DELETED"
          ? t("Finaliser la destruction du titre du dataset sur EVM ?")
          : t("Supprimer ce dataset ? Sa clé de déchiffrement est détruite : la donnée devient définitivement irrécupérable."),
      )
    ) {
      return;
    }
    setError(null);
    setPendingId(dataset.id);
    try {
      await destroyDataset(dataset.id);
      await refresh();
    } catch (err) {
      setError(messageOf(err));
      await refresh();
    } finally {
      setPendingId(null);
    }
  }

  // Le bouton ne s'affiche que si le registre refuse encore l'adresse. Sur une
  // instance adossée au registre ouvert il ne paraît jamais ; il revient de lui-même
  // le jour où l'escrow pointera de nouveau sur un registre gouverné.
  const [kybManquant, setKybManquant] = useState<boolean | null>(null);

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
      await acceptKybCredential("provider");
      setKybManquant(false);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  const listed = datasets.filter((d) => d.status === "LISTED").length;

  if (!connected || !address) {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-8">
        <Card className="flex flex-col items-start gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t("Mes actifs data")}</h1>
            <p className="mt-1 text-sm text-muted">{t("Connecte un wallet pour gérer tes datasets.")}</p>
          </div>
          <ConnectCta>{t("Connecter un wallet")}</ConnectCta>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Mes actifs data")}</h1>
          <p className="mt-1 text-sm text-muted">
            {t("{datasets} dataset{datasetSuffix} · {listed} public{publicSuffix}. Chaque titre est l'ancrage on-chain de ta donnée.", {
              datasets: datasets.length,
              datasetSuffix: datasets.length > 1 ? "s" : "",
              listed,
              publicSuffix: listed > 1 ? "s" : "",
            })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ModeToggle />
          {kybManquant === true && (
            <button
              onClick={handleOnboard}
              className="rounded-xl border border-border bg-surface px-3 py-2 text-xs font-medium text-muted transition-colors hover:border-white/20"
            >
              {t("Configurer le KYB")}
            </button>
          )}
          <Link
            href="/datasets/new"
            className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90"
          >
            {t("Déposer")}
          </Link>
        </div>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">
          {t(error)}
        </div>
      )}

      <div className="flex flex-col gap-3">
        {datasets.length === 0 && (
          <p className="py-8 text-center text-sm text-muted">
            {t("Aucun dataset.")} <Link href="/datasets/new" className="text-foreground underline">{t("Dépose ton premier actif")}</Link>.
          </p>
        )}
        {datasets.map((d) => (
          <Card key={d.id}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="truncate font-medium">{d.name}</h3>
                  <Badge variant={STATUS_VARIANT[d.status]}>{t(STATUS_LABEL[d.status])}</Badge>
                </div>
                {d.description && <p className="mt-1 text-sm text-muted">{d.description}</p>}
                <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-3">
                  <Field label={t("Lignes")} value={d.metrics ? String(d.metrics.rowCount) : "—"} />
                  <Field label={t("Colonnes")} value={d.metrics ? String(d.metrics.columnCount) : "—"} />
                  <Field label={t("Taille")} value={formatBytes(d.sizeBytes)} />
                  {advanced && (
                    <>
                      <Field label="CID" value={d.ipfsCid ? truncate(d.ipfsCid) : "—"} mono />
                      <Field label="Merkle" value={d.merkleRoot ? truncate(d.merkleRoot) : "—"} mono />
                      <Field label="Titre EVM" value={d.evmDatasetId ? truncate(d.evmDatasetId) : "—"} mono />
                    </>
                  )}
                </dl>
              </div>
              {(d.status === "DRAFT" || d.status === "LISTING") && (
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <button
                    onClick={() => handleList(d)}
                    disabled={pendingId === d.id || (d.status === "DRAFT" && !d.ipfsCid)}
                    title={!d.ipfsCid ? t("Upload interrompu : supprime ce brouillon et recommence") : undefined}
                    className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
                  >
                    {d.status === "LISTING"
                      ? t("Réconcilier…")
                      : d.ipfsCid
                        ? t("Publier le titre")
                        : t("Upload incomplet")}
                  </button>
                  {d.status === "DRAFT" && (
                    <button
                      onClick={() => handleDelete(d)}
                      disabled={pendingId === d.id}
                      className="text-xs font-medium text-negative/80 transition-colors hover:text-negative disabled:opacity-50"
                    >
                      {t("Supprimer le brouillon")}
                    </button>
                  )}
                </div>
              )}
              {VISIBILITY_STATES.includes(d.status) && (
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <div className="inline-flex rounded-lg border border-border p-0.5">
                    {VISIBILITY_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => handleVisibility(d.id, opt.value)}
                        disabled={pendingId === d.id || d.status === opt.value}
                        title={t(opt.hint)}
                        className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-default ${
                          d.status === opt.value
                            ? "bg-accent text-background"
                            : "text-muted hover:text-foreground disabled:opacity-50"
                        }`}
                      >
                        {t(opt.label)}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => handleDelete(d)}
                    disabled={pendingId === d.id}
                    className="text-xs font-medium text-negative/80 transition-colors hover:text-negative disabled:opacity-50"
                  >
                    {t("Supprimer")}
                  </button>
                </div>
              )}
              {d.status === "DELETED" && d.evmDatasetId && (
                <button
                  onClick={() => handleDelete(d)}
                  disabled={pendingId === d.id}
                  className="shrink-0 rounded-xl border border-negative/40 px-4 py-2 text-sm font-medium text-negative transition-colors hover:border-negative disabled:opacity-50"
                >
                  {pendingId === d.id ? t("Réconciliation…") : t("Finaliser le titre")}
                </button>
              )}
            </div>
          </Card>
        ))}
        {nextCursor && (
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="mx-auto mt-3 rounded-xl border border-border bg-surface px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-white/20 disabled:opacity-50"
          >
            {loadingMore ? t("Chargement…") : t("Afficher plus")}
          </button>
        )}
      </div>
    </main>
  );
}
