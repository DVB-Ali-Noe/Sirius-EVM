import type { ApiKeysOverview, CreatedApiKey } from "./api-keys-client";

/**
 * Clé API créée d'office après le règlement d'un emprunt (D-32, décision du 8 novembre 2026 :
 * toute location inclut l'API). La page Entraîner qui a vu le prêt passer à SETTLED crée UNE clé,
 * par le parcours habituel (génération et scellement dans le navigateur), et en affiche le secret
 * une fois. Jamais deux : le serveur doit lister zéro clé (révoquées comprises, donc jamais après
 * une révocation), un marqueur par prêt dans le navigateur bloque toute nouvelle tentative, un
 * verrou Web Locks sérialise les onglets, une garde en mémoire couvre le double montage de React,
 * et le serveur, qui fait foi, refuse une création d'office (`auto: true`) sur un prêt ayant déjà
 * une clé (`409 api_key_auto_exists`, autre appareil) : ce refus vaut « rien à faire ». Page fermée avant le règlement : rien d'automatique, le bouton « Créer une clé API » reste.
 */

/** Le serveur a refusé la création d'office : le prêt a déjà une clé (autre appareil). Rien à afficher. */
export class AutoApiKeyExistsError extends Error {
  constructor() {
    super("Ce prêt a déjà une clé API : aucune clé n’est créée d’office");
    this.name = "AutoApiKeyExistsError";
  }
}

/** Nom de la clé créée d'office (traduit à l'affichage, puis enregistré tel quel). */
export const AUTO_API_KEY_NAME = "Clé par défaut";

type Overview = Pick<ApiKeysOverview, "keys" | "apiAccess">;

/** Prêt couvert par l'API incluse, sans aucune clé, même révoquée. */
export function shouldAutoCreateApiKey(overview: Overview): boolean {
  return overview.keys.length === 0 && overview.apiAccess.paid && overview.apiAccess.included;
}

interface LoanStatus {
  id: string;
  status: string;
  extendsLoanId?: string | null;
  packForLoanId?: string | null;
}

/**
 * Emprunts vus non réglés à la lecture précédente et réglés à celle-ci : ceux dont la page a suivi
 * le règlement. Prolongations, packs et passes n'ouvrent pas de location.
 */
export function newlySettledLoanIds(previous: readonly LoanStatus[], next: readonly LoanStatus[]): string[] {
  const before = new Map(previous.map((loan) => [loan.id, loan.status]));
  return next
    .filter((loan) => loan.status === "SETTLED" && !loan.extendsLoanId && !loan.packForLoanId)
    .filter((loan) => { const status = before.get(loan.id); return status !== undefined && status !== "SETTLED"; })
    .map((loan) => loan.id);
}

/** Sous-ensemble de `navigator.locks` utilisé (absent : navigateur ancien, tests). */
export interface ExclusiveLocks {
  request<T>(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<T>): Promise<T>;
}

export interface AutoApiKeyDeps {
  list(): Promise<Overview>;
  create(): Promise<CreatedApiKey>;
  /** `localStorage`, ou `null` s'il est inaccessible (navigation privée stricte). */
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  locks: ExclusiveLocks | null;
}

const inFlight = new Set<string>();

const markerKey = (loanId: string) => `sirius:auto-api-key:${loanId}`;

function marked(storage: AutoApiKeyDeps["storage"], loanId: string): boolean {
  try {
    return storage !== null && storage.getItem(markerKey(loanId)) !== null;
  } catch {
    return false;
  }
}

function mark(storage: AutoApiKeyDeps["storage"], loanId: string): void {
  try {
    storage?.setItem(markerKey(loanId), new Date().toISOString());
  } catch {
    // Stockage plein ou refusé : la liste serveur (zéro clé) reste la garde.
  }
}

/**
 * Crée la clé d'office si rien ne s'y oppose ; `null` sinon (déjà tentée, autre onglet en cours,
 * clé existante ou révoquée, API non couverte, refus du serveur `AutoApiKeyExistsError`). Le
 * marqueur est posé AVANT la création : un échec ne relance jamais de création automatique, le
 * bouton manuel prend le relais. Toute autre erreur de création remonte à l'appelant.
 */
export async function autoCreateApiKey(loanId: string, deps: AutoApiKeyDeps): Promise<CreatedApiKey | null> {
  if (inFlight.has(loanId)) return null;
  inFlight.add(loanId);
  try {
    const attempt = async (): Promise<CreatedApiKey | null> => {
      if (marked(deps.storage, loanId)) return null;
      if (!shouldAutoCreateApiKey(await deps.list())) return null;
      if (marked(deps.storage, loanId)) return null;
      mark(deps.storage, loanId);
      try {
        return await deps.create();
      } catch (error) {
        if (error instanceof AutoApiKeyExistsError) return null;
        throw error;
      }
    };
    if (!deps.locks) return await attempt();
    return await deps.locks.request(markerKey(loanId), { ifAvailable: true }, (lock) => (lock ? attempt() : Promise.resolve(null)));
  } finally {
    inFlight.delete(loanId);
  }
}
