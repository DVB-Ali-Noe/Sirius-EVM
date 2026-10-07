import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { ASSISTANT_MAX_OUTPUT_TOKENS, ASSISTANT_MODEL } from "./config";
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
 * - Un `stop_reason` « refusal » final est signalé au client comme tel, sans texte partiel.
 *
 * Le SDK lit `ANTHROPIC_API_KEY` lui-même ; ce module ne manipule jamais la clé. Rien du contenu
 * des messages n'est journalisé : seuls les compteurs (tours, jetons, latence, motif d'arrêt).
 */

export interface AssistantStreamOutcome {
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Événements envoyés au navigateur, un par ligne `data:` du flux SSE. */
export type AssistantEvent =
  | { type: "text"; text: string }
  | { type: "done"; stopReason: string | null }
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
 * Lance la génération et transmet les événements au fur et à mesure. `onEvent` est appelé pour
 * chaque fragment de texte puis une fois pour la fin (`done`, `refusal` ou `error`). Retourne les
 * compteurs à journaliser, ou `null` si l'appel a échoué avant toute réponse.
 */
export async function streamAssistantReply(
  request: AssistantChatRequest,
  onEvent: (event: AssistantEvent) => void,
  signal?: AbortSignal,
): Promise<AssistantStreamOutcome | null> {
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
  // Un refus mi-flux rend le texte déjà envoyé caduc : on l'envoie tout de même au fil de l'eau
  // (latence) et le client remplace tout par le message de refus à la fin.
  stream.on("text", (text) => onEvent({ type: "text", text }));
  const message = await stream.finalMessage();
  const usage = message.usage;
  if (message.stop_reason === "refusal") onEvent({ type: "refusal" });
  else onEvent({ type: "done", stopReason: message.stop_reason });
  return {
    stopReason: message.stop_reason,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}
