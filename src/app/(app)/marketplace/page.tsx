"use client";

import { Suspense } from "react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { MarketplaceCatalogue } from "./_components/MarketplaceCatalogue";

/**
 * Marketplace publique : grille, recherche et filtres, consultables sans wallet.
 *
 * Les filtres vivent dans l'URL (lien partageable, retour arrière) ; filtrage, tri et pagination
 * sont faits par `GET /api/marketplace`, route publique sans session. L'emprunt se fait depuis
 * la fiche `/marketplace/[id]`, seul endroit où la connexion est demandée.
 */
export default function MarketplacePage() {
  return (
    <Suspense fallback={<CatalogueFallback />}>
      <MarketplaceCatalogue />
    </Suspense>
  );
}

function CatalogueFallback() {
  const { t } = useLocale();
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <p className="text-sm text-muted">{t("Chargement…")}</p>
    </main>
  );
}
