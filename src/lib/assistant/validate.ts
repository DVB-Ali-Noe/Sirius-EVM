import { AppError } from "@/lib/app-error";
import { ASSISTANT_MAX_HISTORY, ASSISTANT_MAX_MESSAGE_CHARS, ASSISTANT_MAX_PAGE_CHARS } from "./config";

/**
 * Validation du corps de `POST /api/assistant/chat`, sans dépendance au SDK ni à Next : testable
 * seule. L'historique est tenu par le navigateur et revalidé ici à chaque tour : rôles alternés,
 * premier et dernier messages de l'utilisateur, longueurs bornées. Rien d'autre n'est accepté —
 * ni adresse, ni solde, ni identifiant — et le chemin de page facultatif n'est qu'un contexte.
 */

export type AssistantRole = "user" | "assistant";

export interface AssistantTurn {
  role: AssistantRole;
  content: string;
}

export interface AssistantChatRequest {
  /** Historique validé, dernier message de l'utilisateur compris, dans l'ordre. */
  messages: AssistantTurn[];
  /** Chemin de la page affichée (`/train`), ou `null`. */
  page: string | null;
}

/** Caractères de contrôle hors tabulation et retours à la ligne : jamais dans un prompt. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const PAGE_PATTERN = /^\/[A-Za-z0-9\-_./]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cleanText(value: unknown, maxChars: number, message: string): string {
  if (typeof value !== "string") throw new AppError(message, 400);
  const text = value.replace(CONTROL_CHARS, "").trim();
  if (text.length === 0) throw new AppError(message, 400);
  if (text.length > maxChars) throw new AppError("Message trop long", 413);
  return text;
}

export function validateAssistantChatRequest(input: unknown): AssistantChatRequest {
  if (!isPlainObject(input)) throw new AppError("Requête d’assistant invalide", 400);
  for (const key of Object.keys(input)) {
    if (key !== "messages" && key !== "page") throw new AppError("Requête d’assistant invalide", 400);
  }
  const raw = input.messages;
  if (!Array.isArray(raw) || raw.length === 0) throw new AppError("Requête d’assistant invalide", 400);
  if (raw.length > ASSISTANT_MAX_HISTORY) throw new AppError("Historique trop long", 413);
  const messages: AssistantTurn[] = raw.map((turn, index) => {
    if (!isPlainObject(turn)) throw new AppError("Requête d’assistant invalide", 400);
    const role = turn.role;
    if (role !== "user" && role !== "assistant") throw new AppError("Requête d’assistant invalide", 400);
    const expected: AssistantRole = index % 2 === 0 ? "user" : "assistant";
    if (role !== expected) throw new AppError("Requête d’assistant invalide", 400);
    return { role, content: cleanText(turn.content, ASSISTANT_MAX_MESSAGE_CHARS, "Requête d’assistant invalide") };
  });
  if (messages[messages.length - 1].role !== "user") throw new AppError("Requête d’assistant invalide", 400);

  let page: string | null = null;
  if (input.page !== undefined && input.page !== null) {
    if (typeof input.page !== "string" || input.page.length > ASSISTANT_MAX_PAGE_CHARS || !PAGE_PATTERN.test(input.page)) {
      throw new AppError("Requête d’assistant invalide", 400);
    }
    page = input.page;
  }
  return { messages, page };
}

/** Jour UTC (`AAAA-MM-JJ`) servant de clé au compteur quotidien. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
