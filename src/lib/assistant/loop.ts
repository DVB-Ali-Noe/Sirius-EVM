import type { AssistantTokenUsage } from "./config";
import {
  ASSISTANT_MAX_TOOL_ROUNDS,
  EMPTY_USAGE,
  invalidToolInputResult,
  runAssistantTool,
  sumAssistantUsage,
  validateToolInput,
  type AssistantToolSource,
} from "./tools";

/**
 * Boucle d'outils de l'assistant, sans SDK : `claude.ts` lui fournit l'appel au modèle, elle
 * décide de la suite. Règles, tirées des consignes de l'API en flux :
 *   - au plus `ASSISTANT_MAX_TOOL_ROUNDS` tours d'outils ; ensuite un dernier appel sans droit
 *     d'outil (`tool_choice: none`), pour que la réponse soit du texte ;
 *   - un refus arrête tout, sans exécuter les outils de ce tour ;
 *   - `max_tokens` avec un appel d'outil : l'entrée peut être tronquée, rien n'est exécuté ;
 *   - chaque entrée est revalidée (`validateToolInput`) : hors schéma, l'outil n'est pas lancé
 *     et le modèle reçoit un résultat d'erreur avec ce qu'il a envoyé ;
 *   - les jetons de tous les tours sont additionnés : c'est le coût réel de la question.
 * Le texte envoyé au navigateur est la concaténation des textes des tours (séparés d'une ligne
 * vide) : c'est ce texte-là qui est signé.
 */

export interface LoopToolUse {
  id: string;
  name: string;
  input: unknown;
}

/** Un appel au modèle : texte déjà transmis via `emit`, appels d'outils demandés, usage. */
export interface LoopRound {
  stopReason: string | null;
  text: string;
  /** Blocs de contenu du tour, rejoués tels quels dans le message suivant de l'assistant. */
  content: unknown;
  toolUses: LoopToolUse[];
  usage: AssistantTokenUsage;
}

export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: true };
export type LoopMessage = { role: "user" | "assistant" | "system"; content: unknown };

export interface LoopOptions {
  messages: LoopMessage[];
  /** Appel au modèle ; `toolsAllowed` faux : `tool_choice: none`. `emit` reçoit chaque fragment de texte. */
  call(messages: LoopMessage[], toolsAllowed: boolean, emit: (text: string) => void): Promise<LoopRound>;
  /** Sources des outils ; `null` : aucun outil n'est proposé au modèle. */
  source: AssistantToolSource | null;
  onText: (text: string) => void;
  maxToolRounds?: number;
}

export interface LoopOutcome extends AssistantTokenUsage {
  stopReason: string | null;
  text: string;
  /** Tours d'outils exécutés (0 : réponse directe). */
  toolRounds: number;
}

export async function runAssistantLoop(options: LoopOptions): Promise<LoopOutcome> {
  const maxRounds = options.maxToolRounds ?? ASSISTANT_MAX_TOOL_ROUNDS;
  const messages = [...options.messages];
  let usage: AssistantTokenUsage = { ...EMPTY_USAGE };
  let text = "";
  let toolRounds = 0;
  for (;;) {
    const toolsAllowed = options.source !== null && toolRounds < maxRounds;
    let separated = text.length === 0;
    const round = await options.call(messages, toolsAllowed, (delta) => {
      if (delta.length === 0) return;
      if (!separated) {
        separated = true;
        text += "\n\n";
        options.onText("\n\n");
      }
      text += delta;
      options.onText(delta);
    });
    usage = sumAssistantUsage(usage, round.usage);
    // Un refus mi-flux rend le texte déjà envoyé caduc : le client remplace tout par le message de refus.
    if (round.stopReason === "refusal") return { ...usage, stopReason: "refusal", text: "", toolRounds };
    if (!toolsAllowed || round.toolUses.length === 0 || options.source === null) return { ...usage, stopReason: round.stopReason, text, toolRounds };
    // Entrée d'outil peut-être tronquée : rien n'est exécuté, la réponse s'arrête là.
    if (round.stopReason === "max_tokens") return { ...usage, stopReason: "max_tokens", text, toolRounds };
    const results: ToolResultBlock[] = [];
    for (const use of round.toolUses) {
      const validated = validateToolInput(use.name, use.input);
      const result = validated ? await runAssistantTool(validated, options.source) : invalidToolInputResult(use.input);
      results.push(result.isError
        ? { type: "tool_result", tool_use_id: use.id, content: result.content, is_error: true }
        : { type: "tool_result", tool_use_id: use.id, content: result.content });
    }
    messages.push({ role: "assistant", content: round.content }, { role: "user", content: results });
    toolRounds += 1;
  }
}
