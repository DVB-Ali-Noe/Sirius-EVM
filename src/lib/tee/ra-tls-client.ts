import "server-only";
import { createHash, type X509Certificate } from "node:crypto";
import { Agent, request, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import {
  checkServerIdentity,
  TLSSocket,
  type DetailedPeerCertificate,
  type PeerCertificate,
} from "node:tls";
import { parseRunnerRaTlsEvidence, verifyRunnerRaTlsBinding } from "./ra-tls-evidence";
import { verifyTdxQuote } from "./quote";
import { certificateFromDer, certificatePem } from "./certificate";

const ATTESTATION_CACHE_MS = 5 * 60 * 1_000;
const ATTESTATION_MAX_BYTES = 2 * 1024 * 1024;
const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Next ferme lui-même une connexion keep-alive restée inactive 4 s, bien avant le runner
 * (`keepAliveTimeout` 10 s, src/runner/server.ts). Sans ce délai, l'agent gardait la connexion
 * jusqu'à ce que le runner la ferme, et une requête partie au même moment échouait en ECONNRESET :
 * 503 « Runner confidentiel indisponible », puis succès à l'essai suivant (audit ROB-10, symptôme
 * du 20 octobre). Le délai ne vise que les connexions libres : une requête en cours, même longue
 * (entraînement), n'est pas coupée (seul `timeoutMs` la borne).
 */
export const RUNNER_CLIENT_IDLE_MS = 4_000;
export const RUNNER_AGENT_KEEP_ALIVE = { keepAlive: true, maxSockets: 8, timeout: RUNNER_CLIENT_IDLE_MS } as const;

/** Échec de transport (réseau, TLS, coupure) avec ce qu'il faut pour décider d'un nouvel essai. */
export class RunnerTransportError extends Error {
  constructor(
    readonly code: string | undefined,
    readonly reusedSocket: boolean,
    readonly responseStarted: boolean,
    cause: unknown,
  ) {
    super("Transport runner interrompu", { cause });
    this.name = "RunnerTransportError";
  }
}

/** Le runner (son quote, sa collatérale ou son identité) n'a pas pu être authentifié. */
export class RunnerAttestationError extends Error {
  constructor(message: string, readonly reason: "collateral-unavailable" | "identity" | "transport", cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RunnerAttestationError";
  }
}

const STALE_SOCKET_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED"]);

/**
 * Connexion keep-alive fermée par le runner au moment où Next la réutilisait : coupure sur un socket
 * réutilisé, avant le moindre octet de réponse. Dans ce cas seulement, un nouvel essai est sûr pour
 * une requête sans effet de bord. Un délai dépassé, une erreur TLS ou une réponse entamée ne le sont
 * jamais.
 */
export function isStaleSocketError(error: unknown): boolean {
  return error instanceof RunnerTransportError && error.reusedSocket && !error.responseStarted
    && error.code !== undefined && STALE_SOCKET_CODES.has(error.code);
}

/**
 * Un seul nouvel essai, sur une connexion neuve, quand `retry` l'autorise et que l'échec vient d'une
 * connexion keep-alive périmée. Le délai total reste celui de l'appel. `retry` n'est jamais vrai pour
 * une requête qui scelle, entraîne, paie ou règle (voir runner-client.ts) ; même dans ce cas, le
 * runner refuserait la capability ou le grant déjà consommés (409), sans exécuter deux fois.
 */
export async function withStaleSocketRetry<T>(
  send: (timeoutMs: number) => Promise<T>,
  timeoutMs: number,
  retry: boolean,
  beforeRetry: () => void = () => {},
  now: () => number = Date.now,
): Promise<T> {
  const deadline = now() + timeoutMs;
  try {
    return await send(timeoutMs);
  } catch (error) {
    const remaining = deadline - now();
    if (!retry || !isStaleSocketError(error) || remaining < 1_000) throw error;
    console.warn("[runner-client] connexion keep-alive fermée par le runner : nouvel essai sur une connexion neuve");
    beforeRetry();
    return send(remaining);
  }
}

/** Ferme les connexions libres de l'agent (jamais celles d'une requête en cours). */
export function dropIdleSockets(agent: { freeSockets: NodeJS.ReadOnlyDict<Array<{ destroy(): void }>> }): void {
  for (const sockets of Object.values(agent.freeSockets)) {
    for (const socket of [...(sockets ?? [])]) socket.destroy();
  }
}

/** Cause d'un échec d'appel au runner, sans corps ni en-tête, pour les journaux de Next. */
export function runnerFailureDiagnostic(error: unknown): string {
  if (error instanceof RunnerAttestationError) {
    return error.cause === undefined ? `attestation (${error.reason})` : `attestation (${error.reason} : ${runnerFailureDiagnostic(error.cause)})`;
  }
  if (error instanceof RunnerTransportError) {
    return `réseau (code=${error.code ?? "inconnu"}, socket réutilisé=${error.reusedSocket ? "oui" : "non"}, ` +
      `réponse entamée=${error.responseStarted ? "oui" : "non"})`;
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "délai dépassé";
  return error instanceof Error ? error.name : "inconnue";
}

interface BufferedResponse {
  body: Buffer;
  certificate?: DetailedPeerCertificate;
  headers: Headers;
  status: number;
}

interface BufferedRequestOptions {
  agent: Agent | false;
  body?: Buffer;
  captureCertificate?: boolean;
  headers?: Headers;
  maxBytes: number;
  method: string;
  rejectUnauthorized: boolean;
  timeoutMs: number;
  /** `https.request` en production ; un test peut passer `http.request` avec un agent HTTP. */
  requestImpl?: typeof request;
}

interface AttestedTransport {
  agent: Agent;
  attestedAt: number;
  certificateSha256: string;
  expiresAt: number;
  origin: string;
}

let cachedTransport: AttestedTransport | null = null;
let pendingTransport: { origin: string; promise: Promise<AttestedTransport> } | null = null;

function retireAgent(agent: Agent): void {
  const timer = setTimeout(() => agent.destroy(), 65_000);
  timer.unref();
}

function responseHeaders(raw: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

export function bufferedRequest(url: URL, options: BufferedRequestOptions): Promise<BufferedResponse> {
  return new Promise((resolve, reject) => {
    let responseStarted = false;
    const transportError = (error: unknown) => reject(new RunnerTransportError(
      (error as NodeJS.ErrnoException | undefined)?.code, req.reusedSocket, responseStarted, error,
    ));
    const headers = options.headers ? Object.fromEntries(options.headers.entries()) : undefined;
    const requestOptions: RequestOptions = {
      agent: options.agent,
      headers,
      method: options.method,
      minVersion: "TLSv1.3",
      rejectUnauthorized: options.rejectUnauthorized,
      signal: AbortSignal.timeout(options.timeoutMs),
    };
    const req = (options.requestImpl ?? request)(url, requestOptions, (res) => {
      responseStarted = true;
      let certificate: DetailedPeerCertificate | undefined;
      if (options.captureCertificate) {
        const socket = res.socket;
        if (!(socket instanceof TLSSocket)) {
          res.resume();
          reject(new Error("Connexion runner non TLS"));
          return;
        }
        certificate = socket.getPeerCertificate(true);
        if (!certificate.raw?.length) {
          res.resume();
          reject(new Error("Certificat runner absent"));
          return;
        }
      }

      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += data.length;
        if (size > options.maxBytes) {
          res.destroy(new Error("Réponse runner trop volumineuse"));
          return;
        }
        chunks.push(data);
      });
      res.on("end", () => {
        resolve({
          body: Buffer.concat(chunks),
          certificate,
          headers: responseHeaders(res.headers),
          status: res.statusCode ?? 0,
        });
      });
      res.on("error", transportError);
    });
    req.on("error", transportError);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function certificateChain(peer: DetailedPeerCertificate): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: DetailedPeerCertificate | undefined = peer;
  while (current?.raw?.length) {
    const fingerprint = sha256Hex(current.raw);
    if (seen.has(fingerprint)) break;
    seen.add(fingerprint);
    chain.push(certificatePem(current.raw));
    current = current.issuerCertificate;
  }
  return chain;
}

function assertCertificateHostname(certificate: X509Certificate, hostname: string): void {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  const match = isIP(normalized) ? certificate.checkIP(normalized) : certificate.checkHost(normalized);
  if (!match) throw new Error("Le certificat RA-TLS ne correspond pas à RUNNER_URL");
  const now = Date.now();
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
    throw new Error("Certificat RA-TLS expiré ou pas encore valide");
  }
}

async function attestTransport(baseUrl: URL): Promise<AttestedTransport> {
  let response: BufferedResponse;
  try {
    response = await bufferedRequest(new URL("/ra-tls", baseUrl), {
      agent: false,
      captureCertificate: true,
      maxBytes: ATTESTATION_MAX_BYTES,
      method: "GET",
      rejectUnauthorized: false,
      timeoutMs: 15_000,
    });
  } catch (error) {
    throw new RunnerAttestationError("Preuve RA-TLS du runner injoignable", "transport", error);
  }
  if (response.status !== 200 || !response.certificate) {
    throw new Error(`Bootstrap RA-TLS en échec (${response.status})`);
  }

  const leaf = certificateFromDer(response.certificate.raw);
  assertCertificateHostname(leaf, baseUrl.hostname);
  const certificateSha256 = sha256Hex(leaf.raw);
  const evidence = parseRunnerRaTlsEvidence(response.body);
  const verification = await verifyTdxQuote(evidence.quote, certificateSha256, evidence);
  if (verification.reportDataMatches !== true || verification.hardwareVerified !== true || verification.codeIdentityMatches !== true) {
    // Collatérale Intel injoignable : panne réseau passagère, distinguée d'un refus d'identité dans
    // les journaux (audit ROB-11). Dans les deux cas, aucun appel ne part vers ce runner.
    const reason = verification.hardwareFailure === "collateral-unavailable"
      && verification.reportDataMatches && verification.codeIdentityMatches ? "collateral-unavailable" : "identity";
    throw new RunnerAttestationError("Identité matérielle ou code du runner RA-TLS non authentifié", reason);
  }
  await verifyRunnerRaTlsBinding(evidence, certificateSha256);

  const ca = certificateChain(response.certificate);
  if (ca.length === 0) throw new Error("Chaîne du certificat RA-TLS absente");
  const agent = new Agent({
    ca,
    checkServerIdentity(host: string, certificate: PeerCertificate) {
      const hostnameError = checkServerIdentity(host, certificate);
      if (hostnameError) return hostnameError;
      if (!certificate.raw || sha256Hex(certificate.raw) !== certificateSha256) {
        return new Error("Certificat RA-TLS runner substitué");
      }
      return undefined;
    },
    ...RUNNER_AGENT_KEEP_ALIVE,
    minVersion: "TLSv1.3",
    rejectUnauthorized: true,
  });
  const attestedAt = Date.now();
  return {
    agent,
    attestedAt,
    certificateSha256,
    expiresAt: attestedAt + ATTESTATION_CACHE_MS,
    origin: baseUrl.origin,
  };
}

async function transportFor(baseUrl: URL): Promise<AttestedTransport> {
  if (
    cachedTransport?.origin === baseUrl.origin &&
    cachedTransport.expiresAt > Date.now()
  ) {
    return cachedTransport;
  }
  if (pendingTransport?.origin === baseUrl.origin) return pendingTransport.promise;

  if (cachedTransport) retireAgent(cachedTransport.agent);
  cachedTransport = null;
  const promise = attestTransport(baseUrl);
  pendingTransport = { origin: baseUrl.origin, promise };
  try {
    cachedTransport = await promise;
    return cachedTransport;
  } finally {
    if (pendingTransport?.promise === promise) pendingTransport = null;
  }
}

/** Heure de la dernière vérification complète du runner joignable à cette origine, si elle est encore valable. */
export function runnerAttestedAt(url: URL): number | null {
  return cachedTransport?.origin === url.origin && cachedTransport.expiresAt > Date.now() ? cachedTransport.attestedAt : null;
}

export async function attestedRunnerFetch(
  url: URL,
  init: {
    body?: string;
    headers?: HeadersInit;
    method: "POST" | "GET";
    timeoutMs: number;
    /**
     * POST sans effet de bord (clé publique, re-livraison de clé) : un nouvel essai est permis si la
     * connexion keep-alive était périmée. Un GET l'est toujours. Jamais pour sceller, entraîner,
     * payer ou régler.
     */
    idempotent?: boolean;
  },
): Promise<Response> {
  if (url.protocol !== "https:") throw new Error("Transport RA-TLS réservé à HTTPS");
  const transport = await transportFor(url);
  const body = init.body === undefined ? undefined : Buffer.from(init.body);
  const headers = new Headers(init.headers);
  if (body) headers.set("content-length", String(body.length));
  try {
    const response = await withStaleSocketRetry((timeoutMs) => bufferedRequest(url, {
      agent: transport.agent,
      body,
      headers,
      maxBytes: RESPONSE_MAX_BYTES,
      method: init.method,
      rejectUnauthorized: true,
      timeoutMs,
    }), init.timeoutMs, init.method === "GET" || init.idempotent === true, () => dropIdleSockets(transport.agent));
    return new Response(new Uint8Array(response.body), {
      headers: response.headers,
      status: response.status,
    });
  } catch (error) {
    if (cachedTransport === transport) {
      cachedTransport.agent.destroy();
      cachedTransport = null;
    }
    throw error;
  }
}
