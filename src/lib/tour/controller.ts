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
    this.evaluatedPath = null;
    const active = this.snapshot.active;
    // Un tuto ouvert automatiquement appartenait au wallet précédent : on le ferme sans rien
    // écrire. Un tuto relancé à la main reste ouvert.
    const keep = active?.manual ? active : null;
    if (!next || this.snapshot.suppressed) {
      this.update({ status: "idle", active: keep });
      return;
    }
    this.update({ status: "loading", active: keep });
    void this.load(this.generation, next);
  }

  private async load(generation: number, address: string): Promise<void> {
    const progress = await fetchTourProgress(this.deps.fetch, address);
    if (generation !== this.generation) return;
    if (!progress) {
      this.update({ status: "unavailable" });
      return;
    }
    this.progress = progress;
    // Fermetures notées localement mais jamais confirmées : on les renvoie une fois.
    const { patch, remaining } = reconcilePending(progress, readPending(this.deps.storage(), address));
    writePending(this.deps.storage(), address, remaining);
    if (remaining.welcome || remaining.pages.length > 0) void this.persist(address, patch);
    this.update({ status: "ready" });
    this.evaluate();
  }

  /** Chemin affiché (depuis le layout). */
  setPath(pathname: string | null): void {
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

  /** Décide d'une ouverture automatique, une seule fois par chemin et par wallet. */
  private evaluate(): void {
    if (this.snapshot.suppressed || this.snapshot.status !== "ready" || !this.progress || !this.address) return;
    if (this.path === null || this.evaluatedPath === this.path) return;
    this.evaluatedPath = this.path;
    if (this.snapshot.active) return;
    const pending = readPending(this.deps.storage(), this.address);
    if (!isWelcomeDone(this.progress, pending)) {
      this.update({ active: { kind: "welcome", manual: false, id: ++this.openings } });
      return;
    }
    const key = this.snapshot.pageKey;
    if (!key || isPageSeen(this.progress, pending, key)) return;
    this.update({ active: { kind: "page", key, manual: false, id: ++this.openings } });
  }

  /** Relance le tuto de première connexion (menu profil). Fonctionne connecté ou non. */
  restartWelcome(): void {
    if (!this.snapshot.started) this.start();
    this.update({ active: { kind: "welcome", manual: true, id: ++this.openings } });
  }

  /** Relance le tuto d'une page (bouton « ? »). */
  openPage(key: TourPageKey): void {
    if (!this.snapshot.started) this.start();
    this.update({ active: { kind: "page", key, manual: true, id: ++this.openings } });
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
    if (!address) return;
    const pending = readPending(this.deps.storage(), address);
    let patch: TourPatch;
    if (tour.kind === "welcome") {
      if (this.progress?.welcomeDone) return;
      if (this.progress) this.progress = { ...this.progress, welcomeDone: true };
      pending.welcome = true;
      patch = { tourCompletedAt: true };
    } else {
      if (this.progress?.pages[tour.key] === true) return;
      if (this.progress) this.progress = { ...this.progress, pages: { ...this.progress.pages, [tour.key]: true } };
      if (!pending.pages.includes(tour.key)) pending.pages.push(tour.key);
      patch = { featureTours: { [tour.key]: true } };
    }
    writePending(this.deps.storage(), address, pending);
    void this.persist(address, patch);
  }

  /** PATCH puis, s'il réussit, retrait de la note locale correspondante. N'échoue jamais. */
  private async persist(address: string, patch: TourPatch): Promise<void> {
    const saved = await saveTourProgress(this.deps.fetch, patch);
    if (!saved) return;
    const pending = readPending(this.deps.storage(), address);
    if (patch.tourCompletedAt) pending.welcome = false;
    const savedKeys = Object.keys(patch.featureTours ?? {});
    pending.pages = pending.pages.filter((key) => !savedKeys.includes(key));
    writePending(this.deps.storage(), address, pending);
  }
}
