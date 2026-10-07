import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { ASSISTANT_MAX_OUTPUT_TOKENS, ASSISTANT_MODEL, type AssistantTokenUsage } from "./config";
import { SIRIUS_ASSISTANT_SYSTEM_PROMPT } from "./knowledge";
import type { AssistantChatRequest } from "./validate";

/**
 * Appel à Claude pour l'assistant Sirio, en flux.
 *
 * - Le bloc système est figé et marqué `cache_control` : identique à chaque requête, il n'est
 *   facturé en entier qu'à la première lecture de chaque fenêtre de cache.
 * - Modèle `claude-opus-5-5` : la réflexion est toujours active, on ne passe donc aucun paramètre
 *   `thinking` ; la profondeur est pilotée par `output_config.effort` (« low » : réponses courtes).
 * - Replis côté serveur (`fallbacks: "default"`, bêta `server-side-fallback-2026-07-01`) : un
 *   refus du classifieur est rejoué sur le modèle recommandé par l'API au lieu d'échouer.
 * - `signal` : un navigateur parti annule l'appel en amont, rien n'est généré pour personne.
 *
 * Le SDK lit la clé d'API lui-même ; ce module ne la manipule jamais. Rien du contenu des
 * messages n'est journalisé : seuls les compteurs (tours, jetons, latence, motif d'arrêt).
 */

export interface AssistantStreamOutcome extends AssistantTokenUsage {
  stopReason: string | null;
  /** Texte complet de la réponse, pour la signature ; vide après un refus. */
  text: string;
}

/** Événements envoyés au navigateur, un par ligne `data:` du flux SSE. */
export type AssistantEvent =
  | { type: "text"; text: string }
  | { type: "done"; stopReason: string | null; signature: string }
  | { type: "refusal" }
  | { type: "error"; message: string };

let client: Anthropic | null = null;

function getClient(): Anthropic {
  // Deux tentatives au plus : un 429 ou un 529 de l'API ne doit pas faire attendre la bulle une minute.
  client ??= new Anthropic({ maxRetries: 1, timeout: 60_000 });
  return client;
}

/** Messages envoyés au modèle : l'historique tel quel, le chemin de page en contexte du dernier tour. */
export function buildAssistantMessages(request: AssistantChatRequest): Anthropic.Beta.BetaMessageParam[] {
  return request.messages.map((turn, index) => {
    const last = index === request.messages.length - 1;
    if (!last || !request.page) return { role: turn.role, content: turn.content };
    return {
      role: "user",
      content: [
        { type: "text", text: `(The user is currently on the page ${request.page} of the Sirius app.)` },
        { type: "text", text: turn.content },
      ],
    };
  });
}

/** Message d'erreur sûr pour le client (clé française traduite à l'affichage), selon l'erreur du SDK. */
export function assistantErrorMessage(error: unknown): string {
  if (error instanceof Anthropic.RateLimitError) return "Assistant très sollicité — réessaie dans un instant";
  if (error instanceof Anthropic.APIConnectionError) return "Assistant injoignable — réessaie plus tard";
  if (error instanceof Anthropic.APIError && error.status !== undefined && error.status >= 500) {
    return "Assistant momentanément indisponible — réessaie plus tard";
  }
  return "Assistant indisponible pour le moment";
}

/**
 * Lance la génération et transmet chaque fragment de texte à `onText`. Retourne le motif
 * d'arrêt, le texte complet et les jetons consommés (à inscrire au budget du jour). Lève l'erreur
 * du SDK, ou l'erreur d'annulation si `signal` est déclenché.
 */
export async function streamAssistantReply(
  request: AssistantChatRequest,
  onText: (text: string) => void,
  signal?: AbortSignal,
): Promise<AssistantStreamOutcome> {
  const stream = getClient().beta.messages.stream(
    {
      model: ASSISTANT_MODEL,
      max_tokens: ASSISTANT_MAX_OUTPUT_TOKENS,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: SIRIUS_ASSISTANT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: buildAssistantMessages(request),
    },
    { signal },
  );
  let text = "";
  stream.on("text", (delta) => {
    text += delta;
    onText(delta);
  });
  const message = await stream.finalMessage();
  const usage = message.usage;
  return {
    stopReason: message.stop_reason,
    // Un refus mi-flux rend le texte déjà envoyé caduc : le client remplace tout par le message de refus.
    text: message.stop_reason === "refusal" ? "" : text,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}
