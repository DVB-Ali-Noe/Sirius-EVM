import { tourKeyForPath, type TourPageKey } from "./keys";
import {
  canonicalTourAddress,
  fetchTourProgress,
  isPageSeen,
  isWelcomeDone,
  readPending,
  reconcilePending,
  saveTourProgress,
  writePending,
  type FetchLike,
  type StorageLike,
  type TourPatch,
  type TourProgress,
} from "./progress";

/**
 * Orchestration des tutos, sans React : un seul endroit décide quel tuto est ouvert, pour
 * qu'un tuto de page ne s'empile jamais sur le tuto de première connexion.
 *
 * Règles :
 *   - rien ne s'ouvre tout seul sans wallet connecté ET session signée (`authenticated`) ;
 *   - rien ne s'ouvre tout seul tant que la progression n'a pas été lue et validée sur le
 *     serveur ; si la lecture échoue, rien ne s'ouvre (l'utilisateur garde le bouton « ? ») ;
 *   - le tuto de première connexion passe avant celui de la page ; la page sur laquelle il
 *     s'est ouvert garde son propre tuto pour la visite suivante, au lieu d'enchaîner deux
 *     fenêtres ;
 *   - toute fermeture (terminer, passer, Échap, navigation) compte comme « vu » : un tuto
 *     fermé ne se rouvre pas tout seul, même si l'écriture en base échoue (note locale) ;
 *   - un tuto relancé à la main s'ouvre toujours, connecté ou non ; sa fermeture n'écrit
 *     en base que pour un wallet authentifié.
 */

/** Tuto ouvert. `id` change à chaque ouverture : une relance repart de la première étape. */
export type ActiveTour =
  | { kind: "welcome"; manual: boolean; id: number }
  | { kind: "page"; key: TourPageKey; manual: boolean; id: number };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type TourStatus = "idle" | "loading" | "ready" | "unavailable";

export interface TourSnapshot {
  /** Faux côté serveur et pendant l'hydratation : rien n'est rendu avant le montage. */
  started: boolean;
  /** Tutos neutralisés pour la suite e2e (voir `toursSuppressedForE2e`). */
  suppressed: boolean;
  status: TourStatus;
  active: ActiveTour | null;
  /** Tuto de la page affichée, s'il y en a un (pilote le bouton « ? »). */
  pageKey: TourPageKey | null;
}

export interface TourControllerDeps {
  fetch: FetchLike;
  /** Stockage local, ou `null` s'il est indisponible. Appelé à chaque usage. */
  storage: () => StorageLike | null;
  /** Lu une fois, au démarrage côté navigateur. */
  isSuppressed: () => boolean;
}

export const SERVER_TOUR_SNAPSHOT: TourSnapshot = Object.freeze({
  started: false,
  suppressed: false,
  status: "idle",
  active: null,
  pageKey: null,
});

export class TourController {
  private snapshot: TourSnapshot = SERVER_TOUR_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  /** Wallet dont la progression est suivie : connecté ET authentifié, sinon `null`. */
  private address: string | null = null;
  /** Incrémenté à chaque changement de wallet : une réponse tardive d'un autre wallet est ignorée. */
  private generation = 0;
  private progress: TourProgress | null = null;
  /**
   * Fermetures de cet onglet pour le wallet suivi. Elles priment sur une lecture partie
   * avant elles : un GET lent ne rouvre pas un tuto fermé pendant qu'il était en vol.
   */
  private closedHere: { welcome: boolean; pages: Set<TourPageKey> } = { welcome: false, pages: new Set() };
  /** Wallet suivi au moment où le tuto ouvert l'a été (`null` : aucun). */
  private activeOwner: string | null = null;
  private path: string | null = null;
  /** Dernier chemin pour lequel l'ouverture automatique a été décidée (ouverte, différée ou rien). */
  private evaluatedPath: string | null = null;
  private openings = 0;

  constructor(private readonly deps: TourControllerDeps) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): TourSnapshot => this.snapshot;

  private update(patch: Partial<TourSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private open(tour: DistributiveOmit<ActiveTour, "id">): void {
    this.activeOwner = this.address;
    this.update({ active: { ...tour, id: ++this.openings } as ActiveTour });
  }

  /** Démarrage côté navigateur, idempotent. */
  start(): void {
    if (this.snapshot.started) return;
    let suppressed = false;
    try {
      suppressed = this.deps.isSuppressed();
    } catch {
      suppressed = false;
    }
    this.update({ started: true, suppressed });
  }

  /**
   * Wallet affiché et état de sa session. La progression n'est lue que pour un wallet
   * authentifié : sans session, `/api/profile` répondrait 401 et il n'y a rien à ouvrir.
   */
  setIdentity(address: string | null, authenticated: boolean): void {
    const next = authenticated ? canonicalTourAddress(address) : null;
    if (next === this.address) return;
    this.address = next;
    this.generation += 1;
    this.progress = null;
    this.closedHere = { welcome: false, pages: new Set() };
    this.evaluatedPath = null;
    const active = this.snapshot.active;
    // Un tuto ouvert automatiquement appartenait au wallet précédent : on le ferme sans rien
    // écrire. Un tuto relancé à la main reste ouvert ; sa fermeture n'écrira que si aucun
    // autre wallet n'était suivi à son ouverture (voir `markSeen`).
    const keep = active?.manual ? active : null;
    if (!next || this.snapshot.suppressed) {
      this.update({ status: "idle", active: keep });
      return;
    }
    this.update({ status: "loading", active: keep });
    void this.load(this.generation, next);
  }

  private async load(generation: number, address: string): Promise<void> {
    const fetched = await fetchTourProgress(this.deps.fetch, address);
    if (generation !== this.generation) return;
    if (!fetched) {
      this.update({ status: "unavailable" });
      return;
    }
    // Les fermetures faites pendant la lecture l'emportent sur ce qu'elle a renvoyé.
    const pages = { ...fetched.pages };
    for (const key of this.closedHere.pages) pages[key] = true;
    const progress: TourProgress = { welcomeDone: fetched.welcomeDone || this.closedHere.welcome, pages };
    this.progress = progress;
    // Fermetures notées localement mais jamais confirmées : on les renvoie une fois.
    const { patch, remaining } = reconcilePending(fetched, readPending(this.deps.storage(), address));
    writePending(this.deps.storage(), address, remaining);
    if (remaining.welcome || remaining.pages.length > 0) void this.persist(address, patch);
    this.update({ status: "ready" });
    this.evaluate();
  }

  /** Chemin affiché (depuis le layout). */
  setPath(pathname: string): void {
    const pageKey = tourKeyForPath(pathname);
    this.path = pathname;
    const active = this.snapshot.active;
    if (active?.kind === "page" && active.key !== pageKey) {
      // Navigation (retour arrière) pendant un tuto de page : il compte comme fermé.
      this.update({ pageKey, active: null });
      this.markSeen(active);
    } else if (pageKey !== this.snapshot.pageKey) {
      this.update({ pageKey });
    }
    this.evaluate();
  }

  /**
   * Sortie des pages de l'application (démontage du layout) : plus de chemin courant,
   * donc plus d'ouverture automatique tant qu'on n'y revient pas. Un tuto de page ouvert
   * est retiré sans être compté comme vu : il n'était plus affiché. Appelé aussi par le
   * double montage de StrictMode, d'où l'absence de toute écriture ici.
   */
  leavePages(): void {
    this.path = null;
    this.evaluatedPath = null;
    const active = this.snapshot.active;
    this.update({ pageKey: null, active: active?.kind === "page" ? null : active });
  }

  /** Décide d'une ouverture automatique, une seule fois par chemin et par wallet. */
  private evaluate(): void {
    if (this.snapshot.suppressed || this.snapshot.status !== "ready" || !this.progress || !this.address) return;
    if (this.path === null || this.evaluatedPath === this.path) return;
    this.evaluatedPath = this.path;
    if (this.snapshot.active) return;
    const pending = readPending(this.deps.storage(), this.address);
    if (!isWelcomeDone(this.progress, pending)) {
      this.open({ kind: "welcome", manual: false });
      return;
    }
    const key = this.snapshot.pageKey;
    if (!key || isPageSeen(this.progress, pending, key)) return;
    this.open({ kind: "page", key, manual: false });
  }

  /** Relance le tuto de première connexion (menu profil). Fonctionne connecté ou non. */
  restartWelcome(): void {
    if (!this.snapshot.started) this.start();
    this.open({ kind: "welcome", manual: true });
  }

  /** Relance le tuto d'une page (bouton « ? »). */
  openPage(key: TourPageKey): void {
    if (!this.snapshot.started) this.start();
    this.open({ kind: "page", key, manual: true });
  }

  /** Ferme le tuto ouvert, quelle que soit la manière (terminer, passer, Échap). */
  close(): void {
    const active = this.snapshot.active;
    if (!active) return;
    this.update({ active: null });
    this.markSeen(active);
  }

  /** Enregistre qu'un tuto a été vu : immédiatement en mémoire et en note locale, puis en base. */
  private markSeen(tour: ActiveTour): void {
    const address = this.address;
    // Rien à écrire sans wallet suivi, ni pour un tuto ouvert sous un autre wallet (appareil
    // partagé, changement de compte dans l'extension) : il ne doit pas compter pour celui-ci.
    if (!address || (this.activeOwner !== null && this.activeOwner !== address)) return;
    const pending = readPending(this.deps.storage(), address);
    let patch: TourPatch;
    if (tour.kind === "welcome") {
      this.closedHere.welcome = true;
      if (this.progress?.welcomeDone) return;
      if (this.progress) this.progress = { ...this.progress, welcomeDone: true };
      pending.welcome = true;
      patch = { tourCompletedAt: true };
    } else {
      this.closedHere.pages.add(tour.key);
      if (this.progress?.pages[tour.key] === true) return;
      if (this.progress) this.progress = { ...this.progress, pages: { ...this.progress.pages, [tour.key]: true } };
      if (!pending.pages.includes(tour.key)) pending.pages.push(tour.key);
      patch = { featureTours: { [tour.key]: true } };
    }
    writePending(this.deps.storage(), address, pending);
    void this.persist(address, patch);
  }

  /**
   * PATCH puis, s'il est confirmé pour CE wallet, retrait de la note locale correspondante.
   * N'échoue jamais.
   */
  private async persist(address: string, patch: TourPatch): Promise<void> {
    const saved = await saveTourProgress(this.deps.fetch, patch, address);
    if (!saved) return;
    const pending = readPending(this.deps.storage(), address);
    if (patch.tourCompletedAt) pending.welcome = false;
    const savedKeys = Object.keys(patch.featureTours ?? {});
    pending.pages = pending.pages.filter((key) => !savedKeys.includes(key));
    writePending(this.deps.storage(), address, pending);
  }
}
