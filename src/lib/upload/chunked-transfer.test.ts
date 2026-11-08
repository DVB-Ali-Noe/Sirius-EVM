import assert from "node:assert/strict";
import { before, test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { useWalletStore } from "@/stores/wallet";
import { AppError } from "@/lib/app-error";
import { RunnerRetryLater } from "@/lib/runner/failure-policy";
import { buildMerkleTree } from "@/lib/crypto/merkle";
import { priceUsdcToAtomic } from "@/lib/evm/usdc";
import { activateRunnerDelegation, beginRunnerDelegation, issueRunnerGrant } from "@/lib/runner/authorization-client";
import { buildDelegationMessage } from "@/lib/runner/authorization-contract";
import { verifyDatasetReceipt } from "@/lib/runner/receipt";
import type { R2Config } from "@/lib/storage/r2";
import type * as UploadsModule from "@/lib/sirius/chunked-upload";
import type * as TransferModule from "./chunked-transfer";
import type * as IngressClientModule from "@/lib/tee/ingress-client";

/**
 * Bout en bout sans réseau ni base : le module d'envoi du site et de la CLI, les routes d'envoi
 * (logique serveur, base simulée), le runner réel (grant, scellement en arrière-plan) et un R2 en
 * mémoire, que le navigateur remplit par URL pré-signée et que le runner relit.
 */

const ORIGIN = "http://localhost:3000";
const PROVIDER_KEY = "0x59c6995e998f97a5a0044966f094538b2927f5fc5a8c7e1b3e49b920e33e9f8a";
const R2 = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "site",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "sirius-test",
};
const CONFIG: R2Config = { accountId: R2.R2_ACCOUNT_ID, accessKeyId: "site", secretAccessKey: "secret", bucket: R2.R2_BUCKET };
const CHUNK = 64 * 1024;

let uploads: typeof UploadsModule;
let transfer: typeof TransferModule;
let ingress: typeof IngressClientModule;
let provider = "";

before(async () => {
  Object.assign(process.env, {
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5432/test",
    TEE_MODE: "stub",
    SIRIUS_MASTER_KEY: Buffer.alloc(32, 13).toString("base64"),
    EVM_NETWORK: "testnet",
    SIRIUS_APP_ORIGIN: ORIGIN,
    NEXT_PUBLIC_SIRIUS_APP_ORIGIN: ORIGIN,
    SIRIUS_ESCROW_ADDRESS: `0x${"34".repeat(20)}`,
    // Fixture linéaire : profil facultatif depuis D-31, activé explicitement.
    NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS: "linear_regression",
    ...R2,
  });
  delete process.env.RUNNER_URL;
  uploads = await import("@/lib/sirius/chunked-upload");
  transfer = await import("./chunked-transfer");
  ingress = await import("@/lib/tee/ingress-client");

  const account = privateKeyToAccount(PROVIDER_KEY);
  provider = account.address.toLowerCase();
  useWalletStore.getState().setConnected(account.address, "testnet", "external");
  const sessionPublicKey = await beginRunnerDelegation();
  const now = Date.now();
  const message = buildDelegationMessage({
    origin: ORIGIN,
    address: account.address,
    sessionPublicKey,
    network: "testnet",
    issuedAt: now,
    expiresAt: now + 10 * 60_000,
    challengeToken: "challenge.signature",
  });
  await activateRunnerDelegation({ message, walletSignature: await account.signMessage({ message }), sessionPublicKey });
});

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const c = condition as { in?: unknown[]; gt?: Date; gte?: Date };
      return (!c.in || c.in.includes(value)) && (!c.gt || (value as Date) > c.gt) && (!c.gte || (value as Date) >= c.gte);
    }
    return value === condition;
  });
}

function table(rows: Row[]) {
  return {
    rows,
    findUnique: async ({ where }: { where: Row }) => rows.find((row) => matches(row, where)) ?? null,
    findFirst: async ({ where }: { where: Row }) => rows.filter((row) => matches(row, where)).at(-1) ?? null,
    count: async ({ where }: { where: Row }) => rows.filter((row) => matches(row, where)).length,
    aggregate: async ({ where }: { where: Row }) => ({
      _sum: { sizeBytes: rows.filter((row) => matches(row, where)).reduce((sum, row) => sum + Number(row.sizeBytes), 0) || null },
    }),
    create: async ({ data }: { data: Row }) => {
      const row = { id: `upload${rows.length + 1}`, state: "OPEN", manifestSha256: null, error: null, createdAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((row) => matches(row, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    },
  };
}

const TERMS = {
  priceUsdcAtomic: "",
  challengeDays: 7,
  maxRentalDays: 30,
  model: { modelId: "linear_regression", modelVersion: "1.0.0" },
};

function world(datasetId: string, sizeBytes: number) {
  const bucket = new Map<string, Uint8Array<ArrayBuffer>>();
  const datasets = table([
    { id: datasetId, provider, status: "DRAFT", ipfsCid: null, wrappedKey: null, keyDestroyedAt: null, runnerKind: "DEVELOPMENT", runnerDeploymentId: null },
  ]);
  const datasetUpload = table([]);
  const db = { dataset: datasets, datasetUpload, $transaction: async (action: (tx: unknown) => Promise<unknown>) => action(db) };
  const deps = {
    ...uploads.defaultChunkedUploadDeps,
    db,
    storage: () => CONFIG,
    list: async (_config: R2Config, prefix: string) =>
      [...bucket].filter(([key]) => key.startsWith(prefix)).map(([key, object]) => ({ key, size: object.length })),
    put: async (_config: R2Config, key: string, body: Uint8Array<ArrayBuffer>) => {
      bucket.set(key, body);
    },
    deletePrefix: async (_config: R2Config, prefix: string) => {
      for (const key of [...bucket.keys()]) if (key.startsWith(prefix)) bucket.delete(key);
      return 0;
    },
    authorize: async (id: string, who: string, validate?: (terms: { sizeBytes: number }) => Promise<void> | void) => {
      if (who !== provider) throw new AppError("Accès refusé : ressource d’un autre compte", 403);
      const terms = { id, provider: who, sizeBytes, ...TERMS };
      await validate?.(terms);
      return { ...terms, runnerKind: "DEVELOPMENT", runnerDeploymentId: null };
    },
    assertRunner: async () => ({}),
    serializable: async (action: (tx: unknown) => Promise<unknown>) => action(db),
  } as unknown as UploadsModule.ChunkedUploadDeps;

  const keyOf = (url: string) => new URL(url).pathname.replace(`/${R2.R2_BUCKET}/`, "");
  const puts: string[] = [];
  let putFailures: Record<number, number[]> = {};
  const reply = async (action: () => Promise<unknown>, status = 200) => {
    try {
      return Response.json(await action(), { status });
    } catch (error) {
      if (error instanceof AppError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  };
  const api: TransferModule.ChunkedTransferApi = {
    async request(path, init) {
      const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      const match = /^\/api\/datasets\/([^/]+)\/uploads(?:\/([^/]+))?(?:\/(parts|complete))?$/.exec(path);
      assert.ok(match, path);
      const [, id, uploadId, action] = match;
      if (!uploadId) return reply(() => uploads.openDatasetUpload(id, provider, { chunkBytes: body.chunkBytes }, deps), 201);
      if (action === "parts") return reply(() => uploads.presignUploadParts(id, uploadId, provider, body.indexes, deps));
      if (action === "complete") {
        const header = init.headers?.["x-sirius-runner-grant"] ?? "";
        const { parseRunnerGrantHeader } = await import("@/lib/runner/authorization-contract");
        return reply(() => uploads.completeDatasetUpload(id, uploadId, provider, body.manifest, parseRunnerGrantHeader(header)!, deps), 202);
      }
      if (init.method === "DELETE") return reply(() => uploads.abortDatasetUpload(id, uploadId, provider, deps));
      return reply(() => uploads.datasetUploadStatus(id, uploadId, provider, deps));
    },
    async put(url, body) {
      const key = keyOf(url);
      puts.push(key);
      const index = Number(key.split("/").at(-1));
      const failures = putFailures[index];
      if (failures?.length) return new Response("<Error/>", { status: failures.shift() });
      const signed = Number(new URL(url).searchParams.get("X-Amz-SignedHeaders")?.includes("content-length"));
      assert.equal(signed, 1, "la taille doit être signée");
      bucket.set(key, body);
      return new Response(null, { status: 200 });
    },
  };
  return {
    bucket,
    datasets,
    datasetUpload,
    deps,
    api,
    puts,
    failPuts: (plan: Record<number, number[]>) => (putFailures = plan),
  };
}

/** Le runner relit R2 par `fetch` : on le sert depuis le bucket en mémoire. */
async function withRunnerStorage<T>(bucket: Map<string, Uint8Array<ArrayBuffer>>, action: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const key = new URL(String(input)).pathname.replace(`/${R2.R2_BUCKET}/`, "");
    const object = bucket.get(key);
    return object ? new Response(object) : new Response("<Error/>", { status: 404 });
  }) as typeof fetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = original;
  }
}

function csv(rows: number): Buffer {
  const lines = ["surface,pieces,quartier,prix"];
  for (let i = 0; i < rows; i++) lines.push(`${20 + (i % 180)},${1 + (i % 6)},q${i % 9},${(i * 1.7) % 900}`);
  return Buffer.from(`${lines.join("\n")}\n`);
}

function source(file: Buffer): TransferModule.ChunkedFileSource {
  return { sizeBytes: file.length, read: async (offset, length) => new Uint8Array(file.subarray(offset, offset + length)) };
}

function transferDeps(api: TransferModule.ChunkedTransferApi, progress: TransferModule.ChunkedTransferProgress[] = []) {
  return {
    api,
    verifyIngressKey: ingress.verifyIngressKey,
    issueGrant: (datasetId: string, parts: readonly string[]) => issueRunnerGrant("seal-chunked-dataset", { datasetId }, parts),
    onProgress: (event: TransferModule.ChunkedTransferProgress) => progress.push(event),
    chunkBytes: CHUNK,
    pollMs: 5,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5))),
  };
}

test("un gros fichier part en morceaux chiffrés, l'enclave le scelle et le brouillon reçoit son titre", async () => {
  TERMS.priceUsdcAtomic = priceUsdcToAtomic("10")!;
  const file = csv(12_000);
  assert.ok(file.length > 4 * CHUNK);
  const w = world("dataset-e2e", file.length);
  const progress: TransferModule.ChunkedTransferProgress[] = [];

  const { uploadId } = await withRunnerStorage(w.bucket, () =>
    transfer.sendChunkedDataset({ datasetId: "dataset-e2e", sizeBytes: file.length, ...TERMS }, source(file), transferDeps(w.api, progress)),
  );

  const chunkCount = Math.ceil(file.length / CHUNK);
  const dataset = w.datasets.rows[0];
  assert.equal(w.datasetUpload.rows[0].state, "SEALED");
  assert.match(String(dataset.ipfsCid), new RegExp(`^sirius-chunked:v1:${uploadId}:[0-9a-f]{64}$`));
  assert.equal(dataset.merkleRoot, buildMerkleTree(file).root);
  assert.deepEqual(dataset.metrics, { rowCount: 12_000, columnCount: 4 });
  const receipt = verifyDatasetReceipt(String(dataset.runnerReceipt), {
    datasetId: "dataset-e2e",
    cid: String(dataset.ipfsCid),
    wrappedKey: String(dataset.wrappedKey),
    merkleRoot: String(dataset.merkleRoot),
    priceUsdcAtomic: TERMS.priceUsdcAtomic,
    challengeDays: TERMS.challengeDays,
    maxRentalDays: TERMS.maxRentalDays,
    modelId: "linear_regression",
    modelVersion: "1.0.0",
  });
  assert.equal(receipt.owner, provider);
  // R2 ne contient que du chiffré : aucun morceau ne ressemble au CSV.
  assert.equal(w.bucket.size, chunkCount + 1);
  for (const object of w.bucket.values()) assert.ok(!Buffer.from(object).includes("surface,pieces"));
  const uploadsDone = progress.filter((event) => event.phase === "upload");
  assert.equal(uploadsDone.at(-1)?.phase === "upload" && uploadsDone.at(-1)?.sentBytes, file.length);
  assert.equal(progress.at(-1)?.phase, "seal");
});

test("un envoi refusé par R2 est réessayé, avec une nouvelle URL si la sienne a expiré", async () => {
  const file = csv(9_000);
  const w = world("dataset-retry", file.length);
  w.failPuts({ 1: [500, 403], 3: [503] });
  await withRunnerStorage(w.bucket, () =>
    transfer.sendChunkedDataset({ datasetId: "dataset-retry", sizeBytes: file.length, ...TERMS }, source(file), transferDeps(w.api)),
  );
  assert.equal(w.datasetUpload.rows[0].state, "SEALED");
  assert.equal(w.puts.filter((key) => key.endsWith("/chunks/1")).length, 3);
  assert.equal(w.puts.filter((key) => key.endsWith("/chunks/3")).length, 2);
});

test("enclave en démarrage à l'ouverture puis à la clôture : l'envoi attend, garde ses morceaux et se scelle avec un grant neuf", async () => {
  const file = csv(9_000);
  const w = world("dataset-wake", file.length);
  const starting = new Set(["open", "complete"]);
  const grants: string[] = [];
  const api: TransferModule.ChunkedTransferApi = {
    ...w.api,
    async request(path, init) {
      const step = path.endsWith("/complete") ? "complete" : path.endsWith("/uploads") ? "open" : null;
      if (step === "complete") grants.push(init.headers?.["x-sirius-runner-grant"] ?? "");
      // Réponse de la route quand la CVM démarre : rien n'est écrit côté serveur.
      if (step && starting.delete(step)) {
        return Response.json(
          { error: { code: "enclave_starting", message: "Enclave à l’arrêt" }, code: "enclave_starting", retryAfterSeconds: 120 },
          { status: 503, headers: { "retry-after": "120" } },
        );
      }
      return w.api.request(path, init);
    },
  };
  const waits: (number | null)[] = [];
  await withRunnerStorage(w.bucket, () =>
    transfer.sendChunkedDataset({ datasetId: "dataset-wake", sizeBytes: file.length, ...TERMS }, source(file), {
      ...transferDeps(api),
      onEnclaveWaiting: (seconds) => waits.push(seconds),
    }),
  );
  assert.equal(w.datasetUpload.rows.length, 1, "un seul envoi ouvert");
  assert.equal(w.datasetUpload.rows[0].state, "SEALED");
  assert.deepEqual(waits, [120, null, 120, null]);
  assert.equal(grants.length, 2);
  assert.notEqual(grants[0], grants[1], "chaque essai de clôture porte un grant neuf");
});

test("un fichier refusé par l'enclave renvoie son message et ne laisse aucun morceau dans R2", async () => {
  // Assez gros pour plusieurs morceaux, mais une colonne cible incomplète.
  const lines = ["a,b,cible"];
  for (let i = 0; i < 9_000; i++) lines.push(`${i % 7},${i % 11},${i === 4 ? "" : i % 5}`);
  const file = Buffer.from(`${lines.join("\n")}\n`);
  const w = world("dataset-refused", file.length);
  await assert.rejects(
    withRunnerStorage(w.bucket, () =>
      transfer.sendChunkedDataset({ datasetId: "dataset-refused", sizeBytes: file.length, ...TERMS }, source(file), transferDeps(w.api)),
    ),
    /cible/,
  );
  assert.ok(["FAILED", "ABORTED"].includes(String(w.datasetUpload.rows[0].state)));
  assert.equal(w.bucket.size, 0);
  assert.equal(w.datasets.rows[0].ipfsCid, null);
});

test("une coupure pendant l'envoi ferme l'envoi et libère le quota du fournisseur", async () => {
  const file = csv(9_000);
  const w = world("dataset-cut", file.length);
  w.failPuts({ 2: [500, 500, 500, 500] });
  await assert.rejects(
    transfer.sendChunkedDataset({ datasetId: "dataset-cut", sizeBytes: file.length, ...TERMS }, source(file), transferDeps(w.api)),
    /Envoi du morceau 3 impossible \(HTTP 500\)/,
  );
  assert.equal(w.datasetUpload.rows[0].state, "ABORTED");
  assert.equal(w.bucket.size, 0);
});

/**
 * Pauses enregistrées sans attendre : les essais de la clôture se comptent sans ralentir les tests.
 * Chaque pause rend tout de même la main à la boucle d'événements, où le runner scelle en arrière-plan.
 */
function countedSleeps() {
  const sleeps: number[] = [];
  const sleep = (ms: number) => {
    sleeps.push(ms);
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    return promise;
  };
  return { sleeps, sleep };
}

test("un autre scellement en cours sur le runner (503) : l'envoi garde ses morceaux et relance la clôture avec un grant neuf", async () => {
  const file = csv(9_000);
  const w = world("dataset-busy", file.length);
  const startSeal = w.deps.startSeal;
  let busy = 2;
  w.deps.startSeal = async (input) => {
    if (busy-- > 0) throw new RunnerRetryLater("Un autre scellement est en cours : réessaie dans quelques minutes");
    return startSeal(input);
  };
  const grants: string[] = [];
  const methods: string[] = [];
  const api: TransferModule.ChunkedTransferApi = {
    ...w.api,
    async request(path, init) {
      methods.push(init.method);
      if (path.endsWith("/complete")) grants.push(init.headers?.["x-sirius-runner-grant"] ?? "");
      return w.api.request(path, init);
    },
  };
  const { sleeps, sleep } = countedSleeps();
  await withRunnerStorage(w.bucket, () =>
    transfer.sendChunkedDataset({ datasetId: "dataset-busy", sizeBytes: file.length, ...TERMS }, source(file), { ...transferDeps(api), sleep }),
  );
  assert.equal(w.datasetUpload.rows.length, 1, "aucun nouvel envoi : le quota n'est pas consommé deux fois");
  assert.equal(w.datasetUpload.rows[0].state, "SEALED");
  assert.ok(!methods.includes("DELETE"), "l'envoi n'est jamais supprimé");
  assert.equal(grants.length, 3);
  assert.equal(new Set(grants).size, 3, "chaque clôture porte un grant neuf");
  assert.deepEqual(sleeps.slice(0, 2), [5_000, 10_000], "attente croissante entre deux clôtures");
  assert.equal(w.puts.length, Math.ceil(file.length / CHUNK), "aucun morceau renvoyé");
});

test("réponse de clôture perdue, 5xx et scellement rouvert pendant le suivi : l'envoi se scelle sans être supprimé", async () => {
  const file = csv(9_000);
  const w = world("dataset-flaky", file.length);
  // Premier scellement perdu : le runner redémarre, il ne le connaît plus et le site rouvre l'envoi.
  const { startSeal, sealStatus } = w.deps;
  let restarted = true;
  w.deps.startSeal = async (input) => (restarted ? { state: "sealing", startedAt: 0 } : startSeal(input));
  w.deps.sealStatus = async (datasetId, uploadId) => {
    if (restarted) {
      restarted = false;
      throw new AppError("Scellement inconnu de ce runner", 404);
    }
    return sealStatus(datasetId, uploadId);
  };
  let lostCompletes = 1;
  let brokenPolls = 2;
  const calls: string[] = [];
  const api: TransferModule.ChunkedTransferApi = {
    ...w.api,
    async request(path, init) {
      calls.push(`${init.method} ${path}`);
      const response = await w.api.request(path, init);
      // La clôture est acceptée par le site, mais la connexion tombe avant la réponse.
      if (path.endsWith("/complete") && lostCompletes-- > 0) throw new TypeError("fetch failed");
      if (init.method === "GET" && brokenPolls-- > 0) return Response.json({ error: "Bad gateway" }, { status: 502 });
      return response;
    },
  };
  const { sleep } = countedSleeps();
  await withRunnerStorage(w.bucket, () =>
    transfer.sendChunkedDataset({ datasetId: "dataset-flaky", sizeBytes: file.length, ...TERMS }, source(file), { ...transferDeps(api), sleep }),
  );
  assert.equal(w.datasetUpload.rows.length, 1);
  assert.equal(w.datasetUpload.rows[0].state, "SEALED");
  assert.ok(!calls.some((call) => call.startsWith("DELETE")));
  assert.ok(calls.filter((call) => call.endsWith("/complete")).length >= 2, "clôture relancée");
});

test("un 409 d'une clôture précédente ne fait pas supprimer l'envoi après une panne passagère", async () => {
  const file = csv(9_000);
  const w = world("dataset-conflict", file.length);
  // Clôture 1 : 409 ; suivi : 502 ; clôture 2 : 503 ; suivi : envoi toujours ouvert ; clôture 3 : acceptée.
  const completes = [
    () => Response.json({ error: "Envoi déjà clôturé" }, { status: 409 }),
    () => Response.json({ error: "Runner saturé : réessaie plus tard" }, { status: 503 }),
  ];
  let brokenPolls = 1;
  const calls: string[] = [];
  const api: TransferModule.ChunkedTransferApi = {
    ...w.api,
    async request(path, init) {
      calls.push(`${init.method} ${path}`);
      if (path.endsWith("/complete") && completes.length) return completes.shift()!();
      if (init.method === "GET" && path.includes("/uploads/") && brokenPolls-- > 0) return Response.json({ error: "Bad gateway" }, { status: 502 });
      return w.api.request(path, init);
    },
  };
  await withRunnerStorage(w.bucket, () =>
    transfer.sendChunkedDataset({ datasetId: "dataset-conflict", sizeBytes: file.length, ...TERMS }, source(file), { ...transferDeps(api), ...countedSleeps() }),
  );
  assert.equal(w.datasetUpload.rows[0].state, "SEALED");
  assert.ok(!calls.some((call) => call.startsWith("DELETE")));
  assert.equal(calls.filter((call) => call.endsWith("/complete")).length, 3);
});

test("clôture refusée (4xx) ou runner indisponible trop longtemps : seul le refus supprime l'envoi", async () => {
  const file = csv(9_000);
  const refused = world("dataset-4xx", file.length);
  refused.deps.startSeal = async () => {
    throw new AppError("Grant runner hors scope ou expiré", 403);
  };
  await assert.rejects(
    transfer.sendChunkedDataset({ datasetId: "dataset-4xx", sizeBytes: file.length, ...TERMS }, source(file), { ...transferDeps(refused.api), ...countedSleeps() }),
    /hors scope/,
  );
  assert.equal(refused.datasetUpload.rows[0].state, "ABORTED");
  assert.equal(refused.bucket.size, 0);

  const down = world("dataset-down", file.length);
  down.deps.startSeal = async () => {
    throw new RunnerRetryLater("Runner saturé : réessaie plus tard");
  };
  const { sleeps, sleep } = countedSleeps();
  await assert.rejects(
    transfer.sendChunkedDataset({ datasetId: "dataset-down", sizeBytes: file.length, ...TERMS }, source(file), { ...transferDeps(down.api), sleep }),
    (error: Error) => /^Clôture impossible pour l’instant/.test(error.message) && /Runner saturé/.test(String((error.cause as Error)?.message)),
  );
  assert.equal(sleeps.length, 7, "essais bornés");
  assert.ok(Math.max(...sleeps) <= 60_000);
  // Morceaux gardés : le reaper les supprimera à l'échéance de l'envoi.
  assert.equal(down.datasetUpload.rows[0].state, "OPEN");
  assert.equal(down.bucket.size, Math.ceil(file.length / CHUNK) + 1);
});
