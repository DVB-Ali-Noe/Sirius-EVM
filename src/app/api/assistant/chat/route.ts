import { NextResponse } from "next/server";
import { assertMutationOrigin } from "@/lib/auth/origin";
import { readSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter, requestClientKey } from "@/lib/http/rate-limit";
import { assistantErrorMessage, streamAssistantReply, type AssistantEvent } from "@/lib/assistant/claude";
import { assistantDailyCap, assistantEnabled } from "@/lib/assistant/config";
import { reserveAssistantRequest } from "@/lib/assistant/daily-cap";
import { utcDay, validateAssistantChatRequest } from "@/lib/assistant/validate";

export const runtime = "nodejs";

const NO_STORE = { "cache-control": "private, no-store" };
/** Corps maximal : vingt messages de mille caractères, avec une marge pour l'encodage. */
const MAX_BODY_BYTES = 128 * 1024;
/** Identifiant de conversation posé par le navigateur : 32 caractères hexadécimaux, sans autre sens. */
const SESSION_HEADER = "x-sirius-assistant-session";
const SESSION_PATTERN = /^[0-9a-f]{32}$/;

// Par adresse IP (ingress fiable) ou wallet signé : dix questions par minute ; par conversation :
// six par minute. Les plafonds globaux par instance s'ajoutent au plafond quotidien en base.
const clientLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 10, maxGlobal: 300 });
const conversationLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 6, maxGlobal: 300 });

const encoder = new TextEncoder();

function sseLine(event: AssistantEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Chat de l'assistant Sirio : relaie la question à Claude et renvoie la réponse en flux SSE.
 *
 * Ouvert aux visiteurs comme aux wallets signés ; l'adresse de session ne sert qu'au débit, elle
 * n'est jamais transmise au modèle. 404 tant que `SIRIUS_ASSISTANT_ENABLED=true` n'est pas posé.
 * Journal : compteurs et latence seulement, jamais le contenu des messages.
 */
export async function POST(req: Request) {
  try {
    if (!assistantEnabled()) return NextResponse.json({ error: "Assistant indisponible" }, { status: 404 });
    assertMutationOrigin(req);
    const session = readSession(req);
    enforceRateLimit(clientLimiter, requestClientKey(req, session?.address));
    const conversation = req.headers.get(SESSION_HEADER)?.trim().toLowerCase() ?? "";
    if (!SESSION_PATTERN.test(conversation)) throw new AppError("Requête d’assistant invalide", 400);
    enforceRateLimit(conversationLimiter, `chat:${conversation}`);
    const request = validateAssistantChatRequest(await readJson(req, MAX_BODY_BYTES));
    await reserveAssistantRequest(prisma.assistantUsage, utcDay(), assistantDailyCap());

    const startedAt = Date.now();
    const turns = request.messages.length;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const outcome = await streamAssistantReply(request, (event) => controller.enqueue(sseLine(event)), req.signal);
          if (outcome) {
            console.log(
              `[assistant] turns=${turns} stop=${outcome.stopReason ?? "none"} in=${outcome.inputTokens} out=${outcome.outputTokens} `
              + `cache_read=${outcome.cacheReadTokens} cache_write=${outcome.cacheWriteTokens} ms=${Date.now() - startedAt}`,
            );
          }
        } catch (error) {
          // Seule la classe de l'erreur : sa cause peut contenir l'URL ou des en-têtes d'API.
          console.warn(`[assistant] échec (${error instanceof Error ? error.name : typeof error}) ms=${Date.now() - startedAt}`);
          controller.enqueue(sseLine({ type: "error", message: assistantErrorMessage(error) }));
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { ...NO_STORE, "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
