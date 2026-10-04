import { TOUR_PAGE_KEYS, isTourPageKey, type TourPageKey } from "./keys";

/**
 * Progression des tutos d'un wallet : lecture et écriture via `/api/profile`, plus un
 * repli local minimal.
 *
 * La base est la source de vérité (`tourCompletedAt`, `featureTours`). Le navigateur ne
 * garde qu'une note « fermé mais pas encore enregistré » par wallet : elle est posée avant
 * chaque PATCH et retirée dès que le serveur a confirmé. Si l'API d'écriture échoue
 * durablement (origine mal configurée, débit dépassé, base en panne), le tuto ne se
 * rouvre donc pas à chaque chargement ; la note est renvoyée au serveur au chargement
 * suivant, puis effacée.
 *
 * Aucune fonction de ce module ne lève : toute erreur réseau, HTTP, JSON ou de stockage
 * devient « progression inconnue » (`null`) ou « écriture non confirmée » (`false`), et
 * l'appelant n'ouvre alors rien d'automatique.
 */

/** Ce que l'interface a besoin de savoir, extrait de la réponse de `/api/profile`. */
export interface TourProgress {
  /** Tuto de première connexion terminé ou fermé (`tourCompletedAt` posé en base). */
  welcomeDone: boolean;
  /** Tutos de page déjà vus. Une clé absente vaut « pas encore vu ». */
  pages: Partial<Record<TourPageKey, boolean>>;
}

/** Fermetures pas encore confirmées par le serveur, mémorisées dans le navigateur. */
export interface PendingProgress {
  welcome: boolean;
  pages: TourPageKey[];
}

/** Modification envoyée à `PATCH /api/profile` : uniquement des `true`, jamais d'effacement. */
export interface TourPatch {
  tourCompletedAt?: true;
  featureTours?: Partial<Record<TourPageKey, true>>;
}

/** Sous-ensemble de `fetch` utilisé ici, injectable dans les tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "json">>;

/** Sous-ensemble de `localStorage`, injectable et éventuellement absent. */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const PENDING_PREFIX = "sirius-tour-pending:";
const MAX_PENDING_CHARS = 1_024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Adresse canonique (minuscules, 20 octets) ou `null`. */
export function canonicalTourAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lower = value.toLowerCase();
  return ADDRESS_PATTERN.test(lower) ? lower : null;
}

/**
 * Lit la réponse de `GET /api/profile`. Exige la forme exacte de la route : un objet dont
 * l'adresse est celle du wallet affiché, `tourCompletedAt` présent (date ou `null`) et
 * `featureTours` objet. Toute autre forme (corps vide, `{}` d'un bouchon de test, profil
 * d'un autre wallet resté en session) donne `null`, c'est-à-dire « ne rien ouvrir ».
 */
export function parseTourProgress(body: unknown, expectedAddress: string): TourProgress | null {
  const expected = canonicalTourAddress(expectedAddress);
  if (!expected || !isPlainObject(body)) return null;
  if (canonicalTourAddress(body.address) !== expected) return null;
  if (!Object.hasOwn(body, "tourCompletedAt")) return null;
  const completed = body.tourCompletedAt;
  if (completed !== null && (typeof completed !== "string" || completed.length === 0)) return null;
  if (!isPlainObject(body.featureTours)) return null;
  const pages: TourProgress["pages"] = {};
  for (const key of TOUR_PAGE_KEYS) {
    if (Object.hasOwn(body.featureTours, key) && typeof body.featureTours[key] === "boolean") {
      pages[key] = body.featureTours[key] as boolean;
    }
  }
  return { welcomeDone: completed !== null, pages };
}

/** Progression du wallet connecté, ou `null` si elle est inconnue (échec, réponse inattendue). */
export async function fetchTourProgress(fetchImpl: FetchLike, address: string): Promise<TourProgress | null> {
  try {
    const response = await fetchImpl("/api/profile", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return null;
    return parseTourProgress(await response.json(), address);
  } catch {
    return null;
  }
}

/** Corps JSON du PATCH, ou `null` si la modification est vide (la route refuserait en 400). */
export function tourPatchBody(patch: TourPatch): string | null {
  const body: Record<string, unknown> = {};
  if (patch.tourCompletedAt === true) body.tourCompletedAt = true;
  const pages: Record<string, true> = {};
  for (const key of TOUR_PAGE_KEYS) {
    if (patch.featureTours?.[key] === true) pages[key] = true;
  }
  if (Object.keys(pages).length > 0) body.featureTours = pages;
  return Object.keys(body).length > 0 ? JSON.stringify(body) : null;
}

/** Envoie la progression ; `true` seulement si le serveur a répondu 2xx. */
export async function saveTourProgress(fetchImpl: FetchLike, patch: TourPatch): Promise<boolean> {
  const body = tourPatchBody(patch);
  if (!body) return true;
  try {
    const response = await fetchImpl("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store",
      credentials: "same-origin",
    });
    return response.ok;
  } catch {
    return false;
  }
}

function emptyPending(): PendingProgress {
  return { welcome: false, pages: [] };
}

/** Note locale d'un wallet ; vide si absente, illisible ou si le stockage est indisponible. */
export function readPending(storage: StorageLike | null, address: string): PendingProgress {
  const canonical = canonicalTourAddress(address);
  if (!storage || !canonical) return emptyPending();
  try {
    const raw = storage.getItem(PENDING_PREFIX + canonical);
    if (typeof raw !== "string" || raw.length > MAX_PENDING_CHARS) return emptyPending();
    const value: unknown = JSON.parse(raw);
    if (!isPlainObject(value)) return emptyPending();
    const pages = Array.isArray(value.pages) ? [...new Set(value.pages.filter(isTourPageKey))] : [];
    return { welcome: value.welcome === true, pages };
  } catch {
    return emptyPending();
  }
}

/** Remplace la note locale d'un wallet ; une note vide est supprimée. Sans effet si le stockage échoue. */
export function writePending(storage: StorageLike | null, address: string, pending: PendingProgress): void {
  const canonical = canonicalTourAddress(address);
  if (!storage || !canonical) return;
  try {
    const pages = [...new Set(pending.pages.filter(isTourPageKey))];
    if (!pending.welcome && pages.length === 0) storage.removeItem(PENDING_PREFIX + canonical);
    else storage.setItem(PENDING_PREFIX + canonical, JSON.stringify({ welcome: pending.welcome, pages }));
  } catch {
    // Stockage plein, interdit (navigation privée) ou absent : le repli local est perdu,
    // rien d'autre. Le serveur reste la source de vérité.
  }
}

/** Le tuto de première connexion est-il à considérer comme fait ? */
export function isWelcomeDone(progress: TourProgress, pending: PendingProgress): boolean {
  return progress.welcomeDone || pending.welcome;
}

/** Le tuto de cette page est-il à considérer comme vu ? */
export function isPageSeen(progress: TourProgress, pending: PendingProgress, key: TourPageKey): boolean {
  return progress.pages[key] === true || pending.pages.includes(key);
}

/**
 * Ce qu'il faut renvoyer au serveur au chargement : les fermetures notées localement que
 * la base ne connaît pas encore. Ce qui est déjà en base est retiré de la note.
 */
export function reconcilePending(progress: TourProgress, pending: PendingProgress): { patch: TourPatch; remaining: PendingProgress } {
  const patch: TourPatch = {};
  const remaining: PendingProgress = { welcome: false, pages: [] };
  if (pending.welcome && !progress.welcomeDone) {
    patch.tourCompletedAt = true;
    remaining.welcome = true;
  }
  for (const key of pending.pages) {
    if (progress.pages[key] === true) continue;
    patch.featureTours = { ...patch.featureTours, [key]: true };
    remaining.pages.push(key);
  }
  return { patch, remaining };
}

/**
 * Les tutos sont-ils neutralisés pour la suite e2e ? Uniquement si le build est celui des
 * tests (`NEXT_PUBLIC_SIRIUS_E2E=1`, jamais posé en staging ni en production) ET que le
 * test a posé le marqueur historique `sirius-tour-seen`, comme il le faisait déjà pour
 * l'ancien tuto. Un test qui veut voir les tutos n'a qu'à ne pas poser ce marqueur.
 */
export function toursSuppressedForE2e(e2eFlag: string | undefined, storage: StorageLike | null): boolean {
  if (e2eFlag !== "1" || !storage) return false;
  try {
    return storage.getItem("sirius-tour-seen") === "1";
  } catch {
    return false;
  }
}
