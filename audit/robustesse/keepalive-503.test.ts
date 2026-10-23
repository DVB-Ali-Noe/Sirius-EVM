/**
 * Hypothèses locales pour la 503 « Runner confidentiel indisponible » du 20 octobre
 * (docs/PHALA-DEMO-IMPLEMENTATION.md, session staging arbres).
 *
 *   NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/robustesse/keepalive-503.test.ts
 *
 * Ce message n'est produit qu'à un endroit : src/lib/tee/runner-client.ts:62, quand l'appel au
 * runner lève une exception qui n'est pas une AppError (erreur réseau, TLS, délai, attestation).
 * Une réponse HTTP du runner, même 503 (« Runner saturé »), aurait donné un autre message.
 *
 * On reproduit ici, sans TLS ni CVM, le transport de src/lib/tee/ra-tls-client.ts : `Agent`
 * keep-alive (maxSockets 8) côté Next, serveur Node réglé comme src/runner/server.ts:221-226
 * (keepAliveTimeout 5 s, headersTimeout 5 s, requestTimeout 30 s, maxRequestsPerSocket 20),
 * et un relais TCP qui ajoute une latence (passerelle Phala, Vercel → CVM). AUDIT_LATENCY_MS
 * (défaut 80 ms par sens), AUDIT_REPS (défaut 3).
 */
import assert from "node:assert/strict";
import { Agent, createServer, request, type Server } from "node:http";
import { connect, createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";

const LATENCY = Number(process.env.AUDIT_LATENCY_MS ?? 80);
const REPS = Number(process.env.AUDIT_REPS ?? 3);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let server: Server;
let proxy: TcpServer;
let proxyPort = 0;
let slowResponseMs = 0;

function delayedPipe(from: Socket, to: Socket) {
  from.on("data", (chunk) => setTimeout(() => { if (!to.destroyed) to.write(chunk); }, LATENCY));
  from.on("end", () => setTimeout(() => to.end(), LATENCY));
  from.on("error", () => setTimeout(() => to.destroy(), LATENCY));
  from.on("close", () => setTimeout(() => to.destroy(), LATENCY + 5));
}

before(async () => {
  server = createServer({ maxHeaderSize: 8 * 1024 }, (req, res) => {
    req.resume();
    req.on("end", () => {
      const reply = () => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); };
      if (slowResponseMs) setTimeout(reply, slowResponseMs); else reply();
    });
  });
  // Mêmes réglages que src/runner/server.ts:221-226.
  server.headersTimeout = 5_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 20;
  server.setTimeout(65_000, (socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const upstream = (server.address() as AddressInfo).port;
  proxy = createTcpServer((client) => {
    const target = connect(upstream, "127.0.0.1");
    delayedPipe(client, target);
    delayedPipe(target, client);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyPort = (proxy.address() as AddressInfo).port;
});

after(() => { proxy?.close(); server?.close(); });

function post(agent: Agent, timeoutMs = 60_000): Promise<{ status: number; reused: boolean; keepAlive?: string }> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from('{"jobId":"audit"}');
    const req = request({ host: "127.0.0.1", port: proxyPort, path: "/run-training", method: "POST", agent,
      headers: { "content-type": "application/json", "content-length": String(body.length) }, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, reused: req.reusedSocket, keepAlive: res.headers["keep-alive"] as string | undefined }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

test(`H1 — socket keep-alive réutilisé au moment où le runner le ferme (latence ${LATENCY} ms/sens)`, async () => {
  const idles = process.env.AUDIT_IDLES ? process.env.AUDIT_IDLES.split(",").map(Number)
    : [4_000, 4_700, 4_850, 4_920, 4_960, 5_000, 5_040, 5_080, 5_150, 5_300, 6_000];
  const rows: string[] = [];
  let failures = 0;
  for (const idle of idles) {
    const outcomes: string[] = [];
    for (let rep = 0; rep < REPS; rep++) {
      const agent = new Agent({ keepAlive: true, maxSockets: 8 });
      const first = await post(agent);
      await wait(idle);
      try {
        const second = await post(agent);
        outcomes.push(`${second.status}${second.reused ? " (réutilisé)" : " (neuf)"}`);
      } catch (error) {
        failures++;
        outcomes.push(`EXCEPTION ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
      }
      if (rep === 0 && idle === idles[0]) rows.push(`en-tête Keep-Alive renvoyé par le serveur : ${first.keepAlive ?? "aucun"}`);
      agent.destroy();
    }
    rows.push(`inactivité ${idle} ms → ${outcomes.join(" | ")}`);
  }
  console.log(`[H1] ${rows.join("\n[H1] ")}\n[H1] exceptions réseau (= 503 « Runner confidentiel indisponible » côté Next) : ${failures}/${idles.length * REPS}`);
  assert.ok(true);
});

test("H1b — 25 appels de suite sur le même agent : maxRequestsPerSocket = 20 ne produit ni 503 ni exception", async () => {
  const agent = new Agent({ keepAlive: true, maxSockets: 8 });
  const statuses: string[] = [];
  for (let i = 0; i < 25; i++) {
    try { statuses.push(String((await post(agent)).status)); } catch (error) { statuses.push(`EXC ${(error as NodeJS.ErrnoException).code}`); }
  }
  agent.destroy();
  console.log(`[H1b] ${statuses.join(",")}`);
  assert.ok(statuses.every((status) => status === "200"));
});

test("H7 — réponse au bout de 35 s : requestTimeout = 30 s ne coupe pas un calcul long (corps déjà reçu)", async () => {
  slowResponseMs = 35_000;
  const agent = new Agent({ keepAlive: true, maxSockets: 8 });
  const started = performance.now();
  let outcome: string;
  try { outcome = String((await post(agent)).status); } catch (error) { outcome = `EXCEPTION ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`; }
  slowResponseMs = 0;
  agent.destroy();
  console.log(`[H7] réponse après ${Math.round(performance.now() - started)} ms : ${outcome}`);
  assert.equal(outcome, "200");
});
