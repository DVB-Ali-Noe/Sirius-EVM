"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { DatasetCard } from "@/components/datasets/DatasetCard";
import { DisclaimerNote } from "@/components/ui/DisclaimerNote";
import { formatCount } from "@/lib/copy/numbers";
import { MODEL_OPTIONS } from "@/lib/models/registry";
import { categoryLabelKey, MARKETPLACE_CATEGORIES } from "@/lib/marketplace/categories";
import { MARKETPLACE_MAX_CANDIDATES, MARKETPLACE_PARAMS, MAX_SEARCH_LENGTH, type MarketplaceParam } from "@/lib/marketplace/query";
import type { CatalogueResponse } from "@/lib/marketplace/catalogue";
import { useFavoritesStore } from "@/stores/favorites";

/** Délai avant d'envoyer la recherche pendant la frappe. */
const SEARCH_DEBOUNCE_MS = 350;

type Changes = Partial<Record<MarketplaceParam, string | null>>;

type LoadResult =
  | { key: string; status: "ready"; data: CatalogueResponse }
  | { key: string; status: "error"; message: string };

/** Seuls les paramètres connus et non vides de l'URL partent vers l'API, dans un ordre stable. */
function apiParams(searchParams: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of MARKETPLACE_PARAMS) {
    const value = searchParams.get(name);
    if (value) params.set(name, value);
  }
  return params;
}

export function MarketplaceCatalogue() {
  const { t } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = useMemo(() => apiParams(new URLSearchParams(searchParams.toString())), [searchParams]);
  const key = query.toString();
  const [result, setResult] = useState<LoadResult | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const favIds = useFavoritesStore((s) => s.ids);
  const toggleFav = useFavoritesStore((s) => s.toggle);

  const update = useCallback((changes: Changes, keepPage = false) => {
    const next = new URLSearchParams(key);
    for (const [name, value] of Object.entries(changes)) {
      if (value === null || value === undefined || value === "") next.delete(name);
      else next.set(name, value);
    }
    if (!keepPage) next.delete("page");
    const search = next.toString();
    router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
  }, [key, pathname, router]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/marketplace${key ? `?${key}` : ""}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as (CatalogueResponse & { error?: unknown }) | null;
        if (controller.signal.aborted) return;
        if (!response.ok || !body || !Array.isArray(body.items)) {
          const message = typeof body?.error === "string" ? body.error : "Catalogue indisponible";
          setResult({ key, status: "error", message });
          return;
        }
        setResult({ key, status: "ready", data: body });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key, status: "error", message: "Catalogue indisponible" });
      });
    return () => controller.abort();
  }, [key]);

  const loading = result?.key !== key;
  const data = result?.status === "ready" ? result.data : null;
  const sort = query.get("sort") ?? "recent";
  const hasFilters = [...query.keys()].some((name) => name !== "sort" && name !== "page");

  // Favoris en premier, mais seulement pour le tri par défaut et à l'intérieur de la page :
  // un tri choisi par le visiteur (prix, emprunts) n'est jamais réordonné en douce.
  const items = useMemo(() => {
    if (!data) return [];
    if (sort !== "recent") return data.items;
    return [...data.items].sort((a, b) => Number(favIds.includes(b.id)) - Number(favIds.includes(a.id)));
  }, [data, favIds, sort]);

  const fees = data ? Object.values(data.computeFees) : [];
  const quoted = fees.some((fee) => fee.kind === "quoted");
  const unknownFee = fees.some((fee) => fee.kind === "unknown");

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6 min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Datasets disponibles")}</h1>
        <p className="mt-1 text-sm text-muted">
          {t("Un emprunt = l’accès à un dataset et un entraînement dans l’enclave. Vous recevez le modèle entraîné, jamais la donnée.")}
        </p>
        <p className="mt-1 text-xs text-muted">
          {t("Consultation libre, sans wallet. La connexion n’est demandée qu’au moment d’emprunter.")}
        </p>
      </header>

      <DisclaimerNote className="mb-6" />

      <form
        role="search"
        className="mb-6"
        onSubmit={(event) => event.preventDefault()}
      >
        <SearchBox value={query.get("q") ?? ""} onCommit={(q) => update({ q })} />
      </form>

      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <div className="min-w-0">
          <button
            type="button"
            className="mb-3 w-full rounded-xl border border-border bg-surface px-4 py-2 text-sm font-medium lg:hidden"
            aria-expanded={filtersOpen}
            aria-controls="marketplace-filters"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            {filtersOpen ? t("Masquer les filtres") : t("Afficher les filtres")}
          </button>
          <aside
            id="marketplace-filters"
            aria-label={t("Filtres")}
            className={`${filtersOpen ? "block" : "hidden"} min-w-0 space-y-5 rounded-xl border border-border bg-surface/50 p-4 text-sm lg:block`}
          >
            <RadioGroup
              legend={t("Catégorie")}
              name="category"
              value={query.get("category") ?? ""}
              options={[{ value: "", label: t("Toutes") }, ...MARKETPLACE_CATEGORIES.map((c) => ({ value: c.id, label: t(categoryLabelKey(c.id)) }))]}
              onChange={(category) => update({ category })}
            />
            <RadioGroup
              legend={t("Modèle")}
              name="model"
              value={query.get("model") ?? ""}
              options={[{ value: "", label: t("Tous") }, ...MODEL_OPTIONS.map((m) => ({ value: m.id, label: m.label }))]}
              onChange={(model) => update({ model })}
            />
            <RangeFilter
              key={`price:${query.get("minPrice") ?? ""}:${query.get("maxPrice") ?? ""}`}
              legend={data ? t("Prix total ({symbol})", { symbol: data.token.symbol }) : t("Prix total")}
              inputMode="decimal"
              min={query.get("minPrice") ?? ""}
              max={query.get("maxPrice") ?? ""}
              onApply={(minPrice, maxPrice) => update({ minPrice, maxPrice })}
            />
            <RangeFilter
              key={`rows:${query.get("minRows") ?? ""}:${query.get("maxRows") ?? ""}`}
              legend={t("Taille (lignes)")}
              inputMode="numeric"
              min={query.get("minRows") ?? ""}
              max={query.get("maxRows") ?? ""}
              onApply={(minRows, maxRows) => update({ minRows, maxRows })}
            />
            <fieldset className="min-w-0">
              <legend className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">{t("Fournisseur")}</legend>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-current"
                  checked={query.get("verified") === "1"}
                  onChange={(event) => update({ verified: event.target.checked ? "1" : null })}
                />
                <span>{t("Vérifiés KYB uniquement")}</span>
              </label>
            </fieldset>
            {hasFilters && (
              <button
                type="button"
                className="text-xs font-medium text-muted underline underline-offset-2 hover:text-foreground"
                onClick={() => router.replace(sort === "recent" ? pathname : `${pathname}?sort=${encodeURIComponent(sort)}`, { scroll: false })}
              >
                {t("Réinitialiser les filtres")}
              </button>
            )}
          </aside>
        </div>

        <section aria-labelledby="marketplace-results" className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 id="marketplace-results" className="text-sm text-muted" aria-live="polite">
              {loading
                ? t("Chargement…")
                : data
                  ? t("{count} datasets", { count: formatCount(data.total) })
                  : t("Catalogue indisponible")}
            </h2>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">{t("Trier par")}</span>
              <select
                className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm"
                value={sort}
                onChange={(event) => update({ sort: event.target.value === "recent" ? null : event.target.value })}
              >
                <option value="recent">{t("Plus récents")}</option>
                <option value="borrowed">{t("Plus empruntés")}</option>
                <option value="price">{t("Prix croissant")}</option>
              </select>
            </label>
          </div>

          {result?.status === "error" && !loading && (
            <div role="alert" className="mb-6 rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">
              {t(result.message)}
            </div>
          )}

          {data && (
            <div className="mb-4 space-y-2 text-xs text-muted">
              {quoted && <p>{t("Les prix incluent les frais de calcul du dernier devis de chaque modèle. Le montant exact est affiché dans le devis, avant tout paiement.")}</p>}
              {unknownFee && <p>{t("Quand les frais de calcul ne sont pas encore connus, la carte indique ce que reçoit le fournisseur ; les frais s’ajoutent dans le devis.")}</p>}
              {!data.kybAvailable && <p>{t("Le statut KYB de certains fournisseurs n’a pas pu être lu. Ils sont affichés sans badge et exclus du filtre « vérifiés ».")}</p>}
              {data.truncated && <p>{t("Seuls les {count} datasets les plus récents ont été parcourus.", { count: formatCount(MARKETPLACE_MAX_CANDIDATES) })}</p>}
            </div>
          )}

          {data && items.length === 0 && (
            <p className="py-10 text-center text-sm text-muted">
              {hasFilters ? t("Aucun dataset ne correspond à ces filtres.") : t("Aucun dataset listé pour l’instant.")}
            </p>
          )}

          {data && items.length > 0 && (
            <ul className={`grid gap-4 sm:grid-cols-2 xl:grid-cols-3 ${loading ? "opacity-60" : ""}`}>
              {items.map((item) => {
                const isFav = favIds.includes(item.id);
                return (
                  <li key={item.id} className="relative min-w-0">
                    <DatasetCard
                      name={item.name}
                      category={item.category ? t(categoryLabelKey(item.category)) : null}
                      modelId={item.modelId}
                      modelVersion={item.modelVersion}
                      rowCount={item.rowCount}
                      columnCount={item.columnCount}
                      sizeBytes={item.sizeBytes}
                      priceAtomic={item.priceAtomic || null}
                      priceKind={item.priceKind}
                      token={data.token}
                      status="online"
                      borrowCount={item.borrowCount}
                      verified={item.verified ?? undefined}
                      href={`/marketplace/${encodeURIComponent(item.id)}`}
                    />
                    {/* Au-dessus du lien étiré de la carte, dans le coin libre en bas à droite. */}
                    <button
                      type="button"
                      onClick={() => toggleFav(item.id)}
                      aria-label={isFav ? t("Retirer des favoris") : t("Ajouter aux favoris")}
                      aria-pressed={isFav}
                      className={`absolute bottom-3 right-3 z-10 flex h-10 w-10 items-center justify-center rounded-full text-lg leading-none transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
                        isFav ? "text-foreground" : "text-muted-foreground hover:text-muted"
                      }`}
                    >
                      <span aria-hidden="true">{isFav ? "★" : "☆"}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {data && data.pageCount > 1 && (
            <nav aria-label={t("Pagination")} className="mt-6 flex flex-wrap items-center justify-center gap-3 text-sm">
              <button
                type="button"
                disabled={data.page <= 1 || loading}
                onClick={() => update({ page: data.page - 1 > 1 ? String(data.page - 1) : null }, true)}
                className="rounded-xl border border-border bg-surface px-4 py-2 font-medium text-muted transition-colors hover:border-white/20 disabled:opacity-50"
              >
                {t("Précédent")}
              </button>
              <span className="text-muted">{t("Page {page} sur {count}", { page: data.page, count: data.pageCount })}</span>
              <button
                type="button"
                disabled={data.page >= data.pageCount || loading}
                onClick={() => update({ page: String(data.page + 1) }, true)}
                className="rounded-xl border border-border bg-surface px-4 py-2 font-medium text-muted transition-colors hover:border-white/20 disabled:opacity-50"
              >
                {t("Suivant")}
              </button>
            </nav>
          )}
        </section>
      </div>
    </main>
  );
}

/**
 * Champ de recherche : envoi après une pause de frappe ou sur Entrée. La valeur de l'URL
 * reprend la main quand elle change d'ailleurs (retour arrière, réinitialisation), sans écraser
 * une frappe en cours.
 */
function SearchBox({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(value);
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setDraft(value);
  }

  useEffect(() => {
    if (draft === synced) return;
    const timer = setTimeout(() => {
      setSynced(draft);
      onCommit(draft);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, synced, onCommit]);

  return (
    <input
      type="search"
      aria-label={t("Rechercher un dataset")}
      value={draft}
      maxLength={MAX_SEARCH_LENGTH}
      placeholder={t("Rechercher par nom ou description")}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && draft !== synced) {
          setSynced(draft);
          onCommit(draft);
        }
      }}
      className="w-full rounded-xl border border-border bg-surface px-4 py-2.5 text-sm outline-hidden placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-accent/60"
    />
  );
}

function RadioGroup({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string | null) => void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">{legend}</legend>
      <div className="space-y-1.5">
        {options.map((option) => (
          <label key={option.value || "all"} className="flex items-center gap-2">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value || null)}
              className="accent-current"
            />
            <span className="min-w-0 wrap-anywhere">{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Fourchette appliquée d'un bloc (bouton ou Entrée), pour ne pas filtrer sur une saisie à moitié tapée. */
function RangeFilter({
  legend,
  inputMode,
  min,
  max,
  onApply,
}: {
  legend: string;
  inputMode: "decimal" | "numeric";
  min: string;
  max: string;
  onApply: (min: string | null, max: string | null) => void;
}) {
  const { t } = useLocale();
  const [low, setLow] = useState(min);
  const [high, setHigh] = useState(max);
  const field = "w-full min-w-0 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm tabular-nums";
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">{legend}</legend>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          onApply(low.trim() || null, high.trim() || null);
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          <input aria-label={t("Minimum")} className={field} inputMode={inputMode} placeholder={t("Min")} value={low} maxLength={40} onChange={(e) => setLow(e.target.value)} />
          <input aria-label={t("Maximum")} className={field} inputMode={inputMode} placeholder={t("Max")} value={high} maxLength={40} onChange={(e) => setHigh(e.target.value)} />

        </div>
        <button type="submit" className="rounded-lg border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-white/20 hover:text-foreground">
          {t("Appliquer")}
        </button>
      </form>
    </fieldset>
  );
}
