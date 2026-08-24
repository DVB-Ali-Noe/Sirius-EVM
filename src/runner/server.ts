import "server-only";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { getEnclaveTlsIdentity, initEnclave, isSimulator } from "@/lib/tee/dstack";
import { AppError } from "@/lib/app-error";
import {
  preflightRunnerCapability,
  runnerCapabilityMatchesScope,
  type RunnerOperation,
} from "@/lib/runner/capability";
import { consumeRunnerReplay } from "@/lib/runner/replay";
import { runnerSettlementAddress } from "@/lib/runner/settlement";
import { datasetIngressKeyFingerprint } from "@/lib/tee/ingress";
import type { RunnerRaTlsEvidence } from "@/lib/tee/types";
import { handleRunnerOp, scopeForRunnerOp } from "./handler";

function boundedSetting(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} doit être un entier entre 1 et ${maximum}`);
  }
  return value;
}

const PORT = boundedSetting("RUNNER_PORT", 4100, 65_535);
const MAX_BODY_BYTES = boundedSetting("RUNNER_MAX_BODY_MB", 24, 24) * 1024 * 1024;
const MAX_CONTROL_BODY_BYTES = 256 * 1024;
const MAX_CONCURRENT_REQUESTS = boundedSetting("RUNNER_MAX_CONCURRENT_REQUESTS", 8, 32);
const MAX_CONCURRENT_UPLOADS = boundedSetting("RUNNER_MAX_CONCURRENT_UPLOADS", 1, 2);
const MAX_CONCURRENT_JOBS = boundedSetting("RUNNER_MAX_CONCURRENT_JOBS", 1, 2);
const MAX_CONNECTIONS = boundedSetting("RUNNER_MAX_CONNECTIONS", 32, 128);
let activeRequests = 0;
let activeUploads = 0;
let activeJobs = 0;

interface StartRunnerOptions {
  port?: number;
  log?: boolean;
}

/**
 * Service runner confidentiel isolé (inc.3d-B, D-25). Seul process détenteur de la master key
 * enclave ; Next l'appelle via HTTP en dev et RA-TLS en production avec des inputs explicites. Le secret partagé protège
 * seulement le transport ; l'autorisation métier vient des grants wallet vérifiés ici.
 */

function maxBodyBytes(op: string): number {
  return op === "seal-dataset" ? MAX_BODY_BYTES : MAX_CONTROL_BODY_BYTES;
}

function declaredBodyLength(req: IncomingMessage, maximum: number): number {
  if (req.headers["transfer-encoding"] !== undefined) {
    throw new AppError("Transfer-Encoding non autorisé", 400);
  }
  const header = req.headers["content-length"];
  if (typeof header !== "string" || !/^[0-9]{1,12}$/.test(header)) {
    throw new AppError("Content-Length requis", 411);
  }
  const length = Number(header);
  if (!Number.isSafeInteger(length) || length > maximum) throw new AppError("Body trop volumineux", 413);
  return length;
}

async function readBody(req: IncomingMessage, expectedLength: number, maximum: number): Promise<Record<string, unknown>> {
  const raw = Buffer.allocUnsafe(expectedLength);
  let size = 0;
  for await (const c of req) {
    const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
    size += chunk.length;
    if (size > maximum || size > expectedLength) throw new AppError("Body trop volumineux", 413);
    chunk.copy(raw, size - chunk.length);
  }
  if (size !== expectedLength) throw new AppError("Content-Length incohérent", 400);
  const text = raw.toString();
  try {
    const body = text ? (JSON.parse(text) as unknown) : {};
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new AppError("JSON runner invalide", 400);
  }
}

export async function handleRunnerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  raTlsEvidence?: RunnerRaTlsEvidence,
): Promise<void> {
  const send = (status: number, obj: unknown) => {
    res.writeHead(status, {
      "cache-control": "no-store",
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(obj));
  };
  try {
    const path = new URL(req.url ?? "/", "http://runner").pathname;
    if (req.method === "GET" && path === "/health") return send(200, { status: "ok" });
    if (req.method === "GET" && path === "/ra-tls") {
      return raTlsEvidence ? send(200, raTlsEvidence) : send(404, { error: "RA-TLS indisponible" });
    }
    if (req.method !== "POST") return send(405, { error: "POST attendu" });
    const op = path.replace(/^\/+/, "");
    const capability = req.headers["x-sirius-runner-capability"];
    const token = Array.isArray(capability) ? undefined : capability;
    const verifiedCapability = preflightRunnerCapability(token, op);
    if (!verifiedCapability) {
      return send(401, { error: "Runner : capability invalide" });
    }
    const expectedLength = declaredBodyLength(req, maxBodyBytes(op));
    const isUpload = op === "seal-dataset";
    const isJob = op === "run-training" || op === "run-loan-job";
    if (
      activeRequests >= MAX_CONCURRENT_REQUESTS ||
      (isUpload && activeUploads >= MAX_CONCURRENT_UPLOADS) ||
      (isJob && activeJobs >= MAX_CONCURRENT_JOBS)
    ) {
      return send(503, { error: "Runner saturé" });
    }

    activeRequests += 1;
    if (isUpload) activeUploads += 1;
    if (isJob) activeJobs += 1;
    try {
      const body = await readBody(req, expectedLength, maxBodyBytes(op));
      const target = scopeForRunnerOp(op, body);
      if (
        verifiedCapability.op !== target.op ||
        !runnerCapabilityMatchesScope(verifiedCapability, target.scope)
      ) {
        return send(401, { error: "Runner : capability hors scope" });
      }
      if (!consumeRunnerReplay("capability", verifiedCapability.nonce, verifiedCapability.exp)) {
        return send(409, { error: "Runner : capability déjà utilisée" });
      }
      send(200, await handleRunnerOp(target.op as RunnerOperation, body));
    } finally {
      activeRequests -= 1;
      if (isUpload) activeUploads -= 1;
      if (isJob) activeJobs -= 1;
    }
  } catch (err) {
    if (err instanceof AppError) return send(err.status, { error: err.message });
    console.error("[runner]", err);
    return send(500, { error: "Erreur runner" });
  }
}

export async function startRunner(
  { port = PORT, log = true }: StartRunnerOptions = {},
): Promise<HttpServer | HttpsServer> {
  const tlsEnabled = process.env.NODE_ENV === "production" || process.env.RUNNER_TLS_ENABLED === "true";
  if (process.env.NODE_ENV === "production") {
    if (process.env.TEE_MODE !== "phala") throw new Error("TEE_MODE=phala obligatoire pour le runner en production");
    if (isSimulator()) throw new Error("Simulateur dstack interdit pour le runner en production");
    for (const name of [
      "RUNNER_TRANSPORT_SECRET",
      "RUNNER_REPLAY_DIR",
      "RUNNER_TLS_HOSTNAME",
      "SIRIUS_EXPECTED_MRTD",
      "SIRIUS_EXPECTED_RTMR3",
      "SIRIUS_EXPECTED_COMPOSE_HASH",
      "SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256",
      "SIRIUS_APP_ORIGIN",
      "XRPL_NETWORK",
      "XRPL_SETTLEMENT_SEED",
      "XRPL_AUDIT_SIGNER_SEED",
    ]) {
      if (!process.env[name]) throw new Error(`${name} obligatoire pour le runner en production`);
    }
  }
  if (process.env.TEE_MODE === "phala") await initEnclave();
  if (tlsEnabled && process.env.TEE_MODE !== "phala") {
    throw new Error("TEE_MODE=phala obligatoire quand TLS runner est activé");
  }

  const tlsIdentity = tlsEnabled ? await getEnclaveTlsIdentity() : null;
  const requestHandler = (req: IncomingMessage, res: ServerResponse) => {
    void handleRunnerRequest(req, res, tlsIdentity?.evidence);
  };

  const server = tlsIdentity
    ? createHttpsServer(
        {
          cert: tlsIdentity.certificateChain.join("\n"),
          key: tlsIdentity.key,
          maxHeaderSize: 8 * 1024,
          minVersion: "TLSv1.3",
        },
        requestHandler,
      )
    : createHttpServer({ maxHeaderSize: 8 * 1024 }, requestHandler);
  server.on("checkContinue", (_req, res) => {
    res.writeHead(417, { connection: "close" });
    res.end();
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 20;
  server.maxConnections = MAX_CONNECTIONS;
  server.setTimeout(65_000, (socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", onError);
      resolve();
    });
  });

  if (log) {
    const address = server.address();
    const listeningPort = address && typeof address === "object" ? address.port : port;
    console.log(
      `[runner] écoute ${tlsIdentity ? "en RA-TLS" : "en HTTP dev"} :${listeningPort} ` +
        `(TEE_MODE=${process.env.TEE_MODE ?? "stub"})`,
    );
    if (tlsIdentity) {
      console.log(`[runner] certificat RA-TLS SHA-256 : ${tlsIdentity.evidence.certificateSha256}`);
    }
    console.log(`[runner] empreinte SHA-256 de la clé d’ingestion : ${datasetIngressKeyFingerprint()}`);
    try {
      console.log(`[runner] compte de règlement XRPL : ${runnerSettlementAddress()}`);
    } catch (err) {
      console.warn("[runner] compte de règlement XRPL non configuré", err);
    }
  }
  return server;
}

if (require.main === module) {
  void startRunner().catch((error) => {
    console.error("[runner] démarrage impossible", error);
    process.exitCode = 1;
  });
}
