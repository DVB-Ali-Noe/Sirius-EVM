/**
 * Adresse publique de l'API développeurs (D-30). `https://api.sirius-data.tech/v1/...` est servie
 * par le même projet Next, réécrite par le proxy vers `/api/v1/...` ; sur cet hôte, aucun autre
 * chemin n'existe (404 JSON), ni page, ni autre route API. Ailleurs, `/api/v1/*` reste joignable
 * directement (tests, staging). Module pur : chargé par le proxy.
 */
export const API_HOSTS: readonly string[] = ["api.sirius-data.tech"];

export const API_HOST_NOT_FOUND = { error: { code: "not_found", message: "Route inconnue" } } as const;

export function isApiHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const name = host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  return API_HOSTS.includes(name);
}

/**
 * Chemin interne servi pour `pathname` sur l'hôte API : `/v1/...` → `/api/v1/...`, `null` pour tout
 * autre chemin (le proxy répond 404). Un chemin contenant `..` ou `//` n'est jamais réécrit.
 */
export function apiHostPath(pathname: string): string | null {
  if (!/^\/v1\/[A-Za-z0-9_\-/]+$/.test(pathname) || pathname.includes("//") || pathname.endsWith("/")) return null;
  return `/api${pathname}`;
}
