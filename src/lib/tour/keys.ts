/**
 * Clés des tutos par page et correspondance avec les chemins de l'application.
 *
 * La liste reprend `FEATURE_TOUR_KEYS` de `src/lib/users/profile.ts`, qui ne peut pas être
 * importé côté navigateur (`server-only`). `tour.test.ts` vérifie que les deux listes restent
 * identiques : une clé présente d'un seul côté ferait refuser le PATCH en 400.
 */
export const TOUR_PAGE_KEYS = ["dashboard", "datasets", "upload", "marketplace", "train", "explorer", "wallet"] as const;
export type TourPageKey = (typeof TOUR_PAGE_KEYS)[number];

/**
 * Chemins exacts dotés d'un tuto. Correspondance stricte, sans préfixe : une future fiche
 * (`/datasets/abc`, `/marketplace/abc`) n'hérite pas du tuto de la liste, dont le texte
 * ne la décrirait pas.
 */
const PATH_TO_KEY: Readonly<Record<string, TourPageKey>> = {
  "/dashboard": "dashboard",
  "/datasets": "datasets",
  "/datasets/new": "upload",
  "/marketplace": "marketplace",
  "/train": "train",
  "/explorer": "explorer",
  "/wallet": "wallet",
};

export function isTourPageKey(value: unknown): value is TourPageKey {
  return typeof value === "string" && (TOUR_PAGE_KEYS as readonly string[]).includes(value);
}

/** Clé du tuto de la page affichée, ou `null` si la page n'en a pas. */
export function tourKeyForPath(pathname: string | null | undefined): TourPageKey | null {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.length > 256) return null;
  // Une barre finale (`/train/`) désigne la même page ; la racine reste « / ».
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return Object.hasOwn(PATH_TO_KEY, path) ? PATH_TO_KEY[path] : null;
}
