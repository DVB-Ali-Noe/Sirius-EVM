/**
 * Configuration de l'assistant Sirio (chat Claude dans la bulle du guide).
 *
 * Interrupteur : `SIRIUS_ASSISTANT_ENABLED` exactement « true ». Absent ou autre valeur, la route
 * répond 404 et la bulle n'affiche que la FAQ et le contact ; aucune clé n'est alors exigée au
 * démarrage. La clé `ANTHROPIC_API_KEY` reste côté serveur, lue par le SDK lui-même : ce module ne
 * la lit, ne la retourne et ne la journalise jamais.
 */

export const ASSISTANT_FLAG = "SIRIUS_ASSISTANT_ENABLED";
export const ASSISTANT_KEY_VARIABLE = "ANTHROPIC_API_KEY";
export const ASSISTANT_DAILY_CAP_VARIABLE = "SIRIUS_ASSISTANT_DAILY_CAP";

/** Modèle imposé par le produit ; identifiant exact de l'API. */
export const ASSISTANT_MODEL = "claude-opus-5-5";
/** Réponses courtes : au-delà, la bulle devient illisible. */
export const ASSISTANT_MAX_OUTPUT_TOKENS = 2_000;
/** Longueur maximale d'un message utilisateur, en caractères. */
export const ASSISTANT_MAX_MESSAGE_CHARS = 1_000;
/** Tours d'historique acceptés (messages utilisateur + assistant), le dernier message compris. */
export const ASSISTANT_MAX_HISTORY = 20;
/** Chemin de page facultatif joint à la question (contexte seulement, jamais de donnée de compte). */
export const ASSISTANT_MAX_PAGE_CHARS = 128;
/** Plafond quotidien de requêtes sur l'instance (toutes sessions), par défaut. */
export const DEFAULT_ASSISTANT_DAILY_CAP = 500;
const MAX_ASSISTANT_DAILY_CAP = 100_000;

export type AssistantEnvironment = { readonly [variable: string]: string | undefined };

/** Vrai seulement si le drapeau vaut exactement « true ». */
export function assistantEnabled(env: AssistantEnvironment = process.env): boolean {
  return env.SIRIUS_ASSISTANT_ENABLED?.trim() === "true";
}

/** Plafond quotidien : entier 1–100000, sinon la valeur par défaut. */
export function assistantDailyCap(env: AssistantEnvironment = process.env): number {
  const raw = env.SIRIUS_ASSISTANT_DAILY_CAP?.trim();
  if (!raw || !/^[1-9][0-9]{0,5}$/.test(raw)) return DEFAULT_ASSISTANT_DAILY_CAP;
  const value = Number(raw);
  return value > MAX_ASSISTANT_DAILY_CAP ? DEFAULT_ASSISTANT_DAILY_CAP : value;
}

/**
 * Contrôle de démarrage : un drapeau posé sans clé est une fonction annoncée qui échouerait à
 * chaque question. Un drapeau absent n'exige rien. Le message ne contient que des noms de variables.
 */
export function assistantStartupNotice(env: AssistantEnvironment = process.env): string | null {
  const flag = env.SIRIUS_ASSISTANT_ENABLED?.trim();
  if (flag && flag !== "true" && flag !== "false") throw new Error("SIRIUS_ASSISTANT_ENABLED doit valoir true ou false");
  if (flag !== "true") return null;
  if (!env.ANTHROPIC_API_KEY?.trim()) throw new Error("SIRIUS_ASSISTANT_ENABLED=true exige ANTHROPIC_API_KEY");
  return `[sirius] ${ASSISTANT_FLAG}=true : assistant Sirio ouvert, ${assistantDailyCap(env)} requêtes par jour au plus.`;
}
