import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";
import { AppError } from "../app-error";
import * as errors from "../errors";
import * as rate from "../http/rate-limit";
import * as body from "../http/body";
import { CONTACT_EMAIL } from "../copy/disclaimers";
import { EN_MESSAGES } from "../i18n/english";
import * as config from "./config";
import { reserveAssistantRequest, type AssistantUsageStore } from "./daily-cap";
import { SIRIUS_ASSISTANT_RULES, SIRIUS_ASSISTANT_SYSTEM_PROMPT, SIRIUS_KNOWLEDGE_BASE } from "./knowledge";
import { utcDay, validateAssistantChatRequest } from "./validate";
import type { AssistantEvent } from "./claude";

const ORIGIN = "https://sirius.example";
const CONVERSATION = "0123456789abcdef0123456789abcdef";

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T> | T): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("le drapeau exige exactement « true » ; le plafond quotidien est borné, 500 par défaut", () => {
  assert.equal(config.assistantEnabled({}), false);
  assert.equal(config.assistantEnabled({ SIRIUS_ASSISTANT_ENABLED: "1" }), false);
  assert.equal(config.assistantEnabled({ SIRIUS_ASSISTANT_ENABLED: " true " }), true);
  assert.equal(config.assistantDailyCap({}), 500);
  assert.equal(config.assistantDailyCap({ SIRIUS_ASSISTANT_DAILY_CAP: "42" }), 42);
  assert.equal(config.assistantDailyCap({ SIRIUS_ASSISTANT_DAILY_CAP: "0" }), 500);
  assert.equal(config.assistantDailyCap({ SIRIUS_ASSISTANT_DAILY_CAP: "abc" }), 500);
  assert.equal(config.assistantDailyCap({ SIRIUS_ASSISTANT_DAILY_CAP: "999999" }), 500);
});

test("le démarrage n'exige la clé que si le drapeau est posé, et jamais la clé dans le message", () => {
  assert.equal(config.assistantStartupNotice({}), null);
  assert.equal(config.assistantStartupNotice({ SIRIUS_ASSISTANT_ENABLED: "false", ANTHROPIC_API_KEY: "sk-secret" }), null);
  assert.throws(() => config.assistantStartupNotice({ SIRIUS_ASSISTANT_ENABLED: "true" }), /ANTHROPIC_API_KEY/);
  assert.throws(() => config.assistantStartupNotice({ SIRIUS_ASSISTANT_ENABLED: "yes" }), /true ou false/);
  const notice = config.assistantStartupNotice({ SIRIUS_ASSISTANT_ENABLED: "true", ANTHROPIC_API_KEY: "sk-secret", SIRIUS_ASSISTANT_DAILY_CAP: "12" });
  assert.match(notice ?? "", /12 requêtes/);
  assert.equal(notice?.includes("sk-secret"), false);
});

test("la validation borne la longueur, l'historique, les rôles et le chemin de page", () => {
  const ok = validateAssistantChatRequest({ messages: [{ role: "user", content: "  Hello\u0000 " }], page: "/train" });
  assert.deepEqual(ok, { messages: [{ role: "user", content: "Hello" }], page: "/train" });
  assert.equal(validateAssistantChatRequest({ messages: [{ role: "user", content: "x" }] }).page, null);
  const long = "a".repeat(config.ASSISTANT_MAX_MESSAGE_CHARS + 1);
  assert.throws(() => validateAssistantChatRequest({ messages: [{ role: "user", content: long }] }), (e: AppError) => e.status === 413);
  const history = Array.from({ length: config.ASSISTANT_MAX_HISTORY + 1 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x" }));
  assert.throws(() => validateAssistantChatRequest({ messages: history }), (e: AppError) => e.status === 413);
  const bad: unknown[] = [
    null, [], {}, { messages: [] }, { messages: [{ role: "assistant", content: "x" }] },
    { messages: [{ role: "user", content: "x" }, { role: "user", content: "y" }] },
    { messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }] },
    { messages: [{ role: "user", content: "   " }] }, { messages: [{ role: "system", content: "x" }] },
    { messages: [{ role: "user", content: "x" }], address: "0xabc" },
    { messages: [{ role: "user", content: "x" }], page: "https://evil" },
    { messages: [{ role: "user", content: "x" }], page: "/" + "a".repeat(200) },
  ];
  for (const input of bad) assert.throws(() => validateAssistantChatRequest(input), (e: AppError) => e.status === 400, JSON.stringify(input));
  assert.equal(utcDay(new Date("2026-10-07T23:59:59Z")), "2026-10-07");
});

test("le plafond quotidien compte en base, atomiquement, et refuse en 429 une fois atteint", async () => {
  const rows = new Map<string, number>();
  const store: AssistantUsageStore = {
    async updateMany({ where, data }) {
      const current = rows.get(where.day);
      if (current === undefined || current >= where.count.lt) return { count: 0 };
      rows.set(where.day, current + data.count.increment);
      return { count: 1 };
    },
    async create({ data }) {
      if (rows.has(data.day)) throw Object.assign(new Error("Unique"), { code: "P2002" });
      rows.set(data.day, data.count);
    },
  };
  await reserveAssistantRequest(store, "2026-10-07", 2);
  await reserveAssistantRequest(store, "2026-10-07", 2);
  await assert.rejects(() => reserveAssistantRequest(store, "2026-10-07", 2), (e: AppError) => e.status === 429);
  assert.equal(rows.get("2026-10-07"), 2);
  await reserveAssistantRequest(store, "2026-10-08", 2);
  assert.equal(rows.get("2026-10-08"), 1);
  // Création concurrente : la ligne apparaît entre l'incrément raté et la création.
  const racing: AssistantUsageStore = {
    updateMany: store.updateMany,
    async create(args) {
      rows.set(args.data.day, 1);
      throw Object.assign(new Error("Unique"), { code: "P2002" });
    },
  };
  await reserveAssistantRequest(racing, "2026-10-09", 5);
  assert.equal(rows.get("2026-10-09"), 2);
});

test("le prompt système est figé et porte les règles : Sirius seulement, pas de conseil financier, jamais de clé privée, contact", () => {
  assert.equal(SIRIUS_ASSISTANT_SYSTEM_PROMPT, `${SIRIUS_KNOWLEDGE_BASE}\n\n${SIRIUS_ASSISTANT_RULES}`);
  assert.equal(SIRIUS_ASSISTANT_SYSTEM_PROMPT, SIRIUS_ASSISTANT_SYSTEM_PROMPT, "constante, pas de fonction");
  for (const expected of [
    /only questions about Sirius/i, /Never give financial, investment/i, /private keys, seed phrases/i,
    /Do not invent features/i, /Reply in the user's language/i, /Keep answers short/i, /no access to the user's wallet/i,
  ]) assert.match(SIRIUS_ASSISTANT_RULES, expected);
  assert.ok(SIRIUS_ASSISTANT_RULES.includes(CONTACT_EMAIL));
  for (const fact of ["Robinhood Chain", "USDG", "test USDC", "KYB", "Run job", "15 minutes", "Withdraw", "3 MB", "sirius_session", "/explorer"]) {
    assert.ok(SIRIUS_KNOWLEDGE_BASE.includes(fact), fact);
  }
  // Aucune variable de temps ni d'identifiant : le préfixe doit être identique à chaque requête.
  assert.doesNotMatch(SIRIUS_ASSISTANT_SYSTEM_PROMPT, /\d{4}-\d{2}-\d{2}T/);
  assert.ok(SIRIUS_ASSISTANT_SYSTEM_PROMPT.length > 4_000, "assez long pour être mis en cache (≥ 512 jetons)");
});

test("les messages d'erreur de l'assistant exposés au client ont une traduction anglaise", () => {
  for (const key of [
    "Assistant indisponible", "Requête d’assistant invalide", "Message trop long", "Historique trop long",
    "Assistant indisponible aujourd’hui : plafond quotidien atteint", "Assistant très sollicité — réessaie dans un instant",
    "Assistant injoignable — réessaie plus tard", "Assistant momentanément indisponible — réessaie plus tard", "Assistant indisponible pour le moment",
  ]) assert.ok(Object.hasOwn(EN_MESSAGES, key), key);
});

// ─── Route : même harnais que src/lib/loans/finality-route.test.ts ────────────────────────────

const ROUTE = "src/app/api/assistant/chat/route.ts";
type Route = typeof import("../../app/api/assistant/chat/route");

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const exports = {};
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(source, { exports, Date, Map, console, TextEncoder, ReadableStream, Response, process: { env: {} }, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Dépendance inattendue : ${name}`);
    return dependencies[name];
  } });
  return exports as T;
}

function fixture(options: { reply?: AssistantEvent[]; fail?: Error; cap?: number } = {}) {
  const calls: { messages: number; page: string | null }[] = [];
  const session = { current: null as { address: string; source: "external" } | null };
  let reserved = 0;
  const route = load<Route>(ROUTE, {
    "next/server": { NextResponse },
    "@/lib/auth/origin": {
      assertMutationOrigin: (req: Request) => {
        if (req.headers.get("origin") !== ORIGIN) throw new AppError("Origine de requête non autorisée", 403);
      },
    },
    "@/lib/auth/session": { readSession: () => session.current },
    "@/lib/db": { prisma: { assistantUsage: {} } },
    "@/lib/errors": errors,
    "@/lib/http/body": body,
    "@/lib/http/rate-limit": rate,
    "@/lib/assistant/claude": {
      assistantErrorMessage: () => "Assistant indisponible pour le moment",
      streamAssistantReply: async (request: { messages: unknown[]; page: string | null }, onEvent: (event: AssistantEvent) => void) => {
        calls.push({ messages: request.messages.length, page: request.page });
        if (options.fail) throw options.fail;
        for (const event of options.reply ?? [{ type: "text", text: "Hi" }, { type: "done", stopReason: "end_turn" }]) onEvent(event);
        return { stopReason: "end_turn", inputTokens: 10, outputTokens: 2, cacheReadTokens: 9, cacheWriteTokens: 0 };
      },
    },
    "@/lib/assistant/config": config,
    "@/lib/assistant/daily-cap": {
      reserveAssistantRequest: async (_store: unknown, _day: string, cap: number) => {
        reserved += 1;
        if (reserved > (options.cap ?? cap)) throw new AppError("Assistant indisponible aujourd’hui : plafond quotidien atteint", 429);
      },
    },
    // Module pur : passé tel quel, comme la configuration.
    "@/lib/assistant/validate": { validateAssistantChatRequest, utcDay },
  });
  const post = (payload: unknown, headers: Record<string, string> = {}) => route.POST(new Request(`${ORIGIN}/api/assistant/chat`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", "x-sirius-assistant-session": CONVERSATION, ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  }));
  return { post, calls, session };
}

async function readSse(response: Response): Promise<AssistantEvent[]> {
  const text = await response.text();
  return text.split("\n\n").filter(Boolean).map((line) => JSON.parse(line.replace(/^data: /, "")) as AssistantEvent);
}

const QUESTION = { messages: [{ role: "user", content: "How do I borrow a dataset?" }], page: "/marketplace" };

test("POST /api/assistant/chat : 404 drapeau absent, sans toucher au modèle", async () => {
  await withEnv({ SIRIUS_ASSISTANT_ENABLED: undefined }, async () => {
    const { post, calls } = fixture();
    const response = await post(QUESTION);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Assistant indisponible" });
    assert.deepEqual(calls, []);
  });
});

test("POST /api/assistant/chat : origine, identifiant de conversation, corps et limites contrôlés avant tout appel", async () => {
  await withEnv({ SIRIUS_ASSISTANT_ENABLED: "true", SIRIUS_TRUST_PROXY_HEADERS: "false" }, async () => {
    const { post, calls } = fixture();
    assert.equal((await post(QUESTION, { origin: "https://evil.example" })).status, 403);
    assert.equal((await post(QUESTION, { "x-sirius-assistant-session": "nope" })).status, 400);
    assert.equal((await post("{not json", {})).status, 400);
    assert.equal((await post({ messages: [{ role: "user", content: "a".repeat(1_001) }] })).status, 413);
    assert.equal((await post({ messages: [{ role: "user", content: "x" }], address: "0xabc" })).status, 400);
    assert.equal((await post(QUESTION, { "content-type": "text/plain" })).status, 415);
    assert.deepEqual(calls, []);
  });
});

test("POST /api/assistant/chat : la réponse arrive en flux SSE, le chemin de page est transmis, rien d'autre", async () => {
  await withEnv({ SIRIUS_ASSISTANT_ENABLED: "true", SIRIUS_TRUST_PROXY_HEADERS: "false" }, async () => {
    const { post, calls } = fixture({ reply: [{ type: "text", text: "Open the " }, { type: "text", text: "Marketplace." }, { type: "done", stopReason: "end_turn" }] });
    const response = await post(QUESTION);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await readSse(response), [
      { type: "text", text: "Open the " }, { type: "text", text: "Marketplace." }, { type: "done", stopReason: "end_turn" },
    ]);
    assert.deepEqual(calls, [{ messages: 1, page: "/marketplace" }]);
  });
});

test("POST /api/assistant/chat : refus et panne du modèle deviennent des événements, jamais un 500 après l'ouverture du flux", async () => {
  await withEnv({ SIRIUS_ASSISTANT_ENABLED: "true", SIRIUS_TRUST_PROXY_HEADERS: "false" }, async () => {
    const refused = fixture({ reply: [{ type: "refusal" }] });
    assert.deepEqual(await readSse(await refused.post(QUESTION)), [{ type: "refusal" }]);
    const failed = fixture({ fail: new Error("boom") });
    const response = await failed.post(QUESTION);
    assert.equal(response.status, 200);
    assert.deepEqual(await readSse(response), [{ type: "error", message: "Assistant indisponible pour le moment" }]);
  });
});

test("POST /api/assistant/chat : plafond quotidien en 429, puis débit par conversation", async () => {
  await withEnv({ SIRIUS_ASSISTANT_ENABLED: "true", SIRIUS_TRUST_PROXY_HEADERS: "false" }, async () => {
    const capped = fixture({ cap: 1 });
    assert.equal((await capped.post(QUESTION)).status, 200);
    const over = await capped.post(QUESTION);
    assert.equal(over.status, 429);
    assert.deepEqual(await over.json(), { error: "Assistant indisponible aujourd’hui : plafond quotidien atteint" });

    const { post } = fixture({ cap: 1_000 });
    const other = "fedcba9876543210fedcba9876543210";
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await post(QUESTION, { "x-sirius-assistant-session": other })).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429]);
  });
});
