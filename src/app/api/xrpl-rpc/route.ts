import { AppError } from "@/lib/app-error";
import { assertMutationOrigin } from "@/lib/auth/origin";
import { readBody } from "@/lib/http/body";
import { FixedWindowRateLimiter, requestClientKey } from "@/lib/http/rate-limit";
import { resolveServerNetwork, XRPL_HTTP_ENDPOINTS } from "@/lib/xrpl/networks";

const RPC_URL = process.env.XRPL_RPC_HTTP || XRPL_HTTP_ENDPOINTS[resolveServerNetwork().network];
const MAX_BODY = 8 * 1024; // un ping/tx XRPL tient large en quelques Ko
const UPSTREAM_TIMEOUT_MS = 5000;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 60;
const MAX_GLOBAL_REQUESTS_PER_WINDOW = 600;
const MAX_TRACKED_CLIENTS = 1_024;
const ALLOWED_COMMANDS = new Set(["ping", "server_info", "account_info", "account_lines", "fee"]);
const rpcLimiter = new FixedWindowRateLimiter({
  windowMs: WINDOW_MS,
  maxPerKey: MAX_REQUESTS_PER_WINDOW,
  maxGlobal: MAX_GLOBAL_REQUESTS_PER_WINDOW,
  maxTrackedKeys: MAX_TRACKED_CLIENTS,
});

const json = (payload: string, status: number) =>
  new Response(payload, { status, headers: { "content-type": "application/json" } });

function rateLimited(req: Request): boolean {
  return !rpcLimiter.consume(requestClientKey(req));
}

function commandOf(body: Uint8Array): string | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(body)) as {
      method?: unknown;
      command?: unknown;
      params?: unknown;
    };
    if (typeof payload.method === "string") return payload.method;
    if (typeof payload.command === "string") return payload.command;
    const params = Array.isArray(payload.params) ? payload.params[0] : undefined;
    return params && typeof params === "object" && typeof (params as { command?: unknown }).command === "string"
      ? (params as { command: string }).command
      : null;
  } catch {
    return null;
  }
}

/**
 * Proxy JSON-RPC rippled (server-to-server) : le provider Web3Auth XRPL ping le
 * `rpcTarget` en HTTP à l'init, mais l'endpoint rippled testnet ne renvoie pas
 * d'en-têtes CORS → un fetch navigateur direct échoue ("Failed to fetch"). On
 * relaie donc via cette route (même origine côté client, pas de CORS).
 *
 * Cible fixe (pas de SSRF). Durci contre l'abus de forwarder ouvert : corps borné
 * + timeout upstream (cf audit inc.3b, D-22).
 */
export async function POST(req: Request): Promise<Response> {
  try {
    assertMutationOrigin(req);
  } catch (err) {
    const status = err instanceof AppError ? err.status : 403;
    return json(JSON.stringify({ error: err instanceof Error ? err.message : "origine interdite" }), status);
  }
  if (rateLimited(req)) return json('{"error":"rate limit"}', 429);

  let body: Uint8Array;
  try {
    body = await readBody(req, MAX_BODY);
  } catch (err) {
    const status = err instanceof AppError ? err.status : 400;
    return json(JSON.stringify({ error: err instanceof Error ? err.message : "requête invalide" }), status);
  }
  const command = commandOf(body);
  if (!command || !ALLOWED_COMMANDS.has(command)) return json('{"error":"commande non autorisée"}', 403);

  try {
    const upstream = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return json(await upstream.text(), upstream.status);
  } catch {
    return json('{"error":"upstream unavailable"}', 502);
  }
}
