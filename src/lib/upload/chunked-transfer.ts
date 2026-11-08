import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { encodeRunnerGrantHeader } from "@/lib/runner/authorization-contract";
import type { DatasetIngressKey } from "@/lib/tee/contract";
import { responseError, retryWhileEnclaveStarts } from "@/lib/train/enclave-wait";
import { ChunkedUploadEncryptor, UPLOAD_CHUNK_BYTES, chunkPlainBytes, manifestSha256 } from "./chunked";

/**
 * Envoi d'un gros dataset, partagé par le site (navigateur) et la CLI (Node) : seuls l'accès à
 * l'API, la lecture du fichier, la vérification de la clé d'ingestion et la signature du grant
 * changent d'un côté à l'autre (docs/UPLOAD-1GO.md, §6).
 *
 * Le fichier est lu morceau par morceau (8 Mio), chiffré sur l'appareil pour l'enclave, puis
 * envoyé directement dans R2 par une URL pré-signée ; quelques morceaux seulement sont en mémoire
 * à la fois, quelle que soit la taille du fichier. Une page rechargée reprend le même envoi en
 * renvoyant tous les morceaux : la clé d'envoi ne quitte jamais la mémoire de la page.
 */

export interface ChunkedFileSource {
  sizeBytes: number;
  /** Octets `[offset, offset + length)` du fichier en clair. */
  read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>>;
}

export interface ChunkedTransferApi {
  /** Requête vers l'API du site (chemin `/api/...`), avec la session du fournisseur. */
  request(path: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<Response>;
  /** `PUT` d'un morceau chiffré vers R2. */
  put(url: string, body: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<Response>;
}

export interface ChunkedDatasetTerms {
  datasetId: string;
  priceUsdcAtomic: string;
  challengeDays: number;
  maxRentalDays: number;
  sizeBytes: number;
  model: { modelId: string; modelVersion: string };
}

export type ChunkedTransferProgress =
  | { phase: "upload"; sentBytes: number; totalBytes: number; sentChunks: number; chunkCount: number }
  | { phase: "seal" };

export interface ChunkedTransferDeps {
  api: ChunkedTransferApi;
  /** Vérifie la clé d'ingestion de l'enclave et renvoie la clé publique brute (P-256, 65 octets). */
  verifyIngressKey(key: DatasetIngressKey): Promise<Uint8Array<ArrayBuffer>>;
  issueGrant(datasetId: string, intentParts: readonly string[]): Promise<RunnerGrant>;
  onProgress?(progress: ChunkedTransferProgress): void;
  signal?: AbortSignal;
  /** Taille claire d'un morceau (8 Mio par défaut ; plus petite dans les tests). */
  chunkBytes?: number;
  /** Morceaux envoyés en parallèle (3 par défaut). */
  concurrency?: number;
  /** Attente entre deux lectures de l'état du scellement. */
  pollMs?: number;
  /** Abandon du suivi du scellement au-delà de ce délai. */
  sealTimeoutMs?: number;
  sleep?(ms: number): Promise<void>;
  /**
   * CVM en démarrage (`503 enclave_starting`) à l'ouverture ou à la clôture : secondes avant le
   * prochain essai, puis `null`. L'envoi reste ouvert et ses morceaux valables pendant l'attente.
   */
  onEnclaveWaiting?(retryInSeconds: number | null): void;
}

interface OpenedUpload {
  uploadId: string;
  chunkBytes: number;
  chunkCount: number;
  sizeBytes: number;
  ingressKey: DatasetIngressKey;
}

interface UploadState {
  state: "OPEN" | "SEALING" | "SEALED" | "FAILED" | "ABORTED";
  error?: string;
}

const PUT_ATTEMPTS = 4;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_POLL_MS = 3_000;
const DEFAULT_SEAL_TIMEOUT_MS = 30 * 60_000;

async function json<T>(response: Response, fallback: string): Promise<T> {
  let body: unknown = {};
  try {
    body = await response.json();
  } catch {
    // Corps absent ou illisible : le message par défaut suffit.
  }
  if (!response.ok) {
    const error = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : fallback;
    throw new Error(error);
  }
  return body as T;
}

function post(api: ChunkedTransferApi, path: string, body: unknown, headers: Record<string, string> = {}) {
  return api.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Requête relancée tant que l'enclave démarre (`503 enclave_starting`, rien n'a été écrit côté
 * serveur) ; toute autre erreur remonte avec le message de la route.
 */
function untilEnclaveReady<T>(deps: ChunkedTransferDeps, sleep: (ms: number) => Promise<void>, send: () => Promise<Response>, fallback: string): Promise<T> {
  return retryWhileEnclaveStarts(async () => {
    const response = await send();
    if (!response.ok) throw await responseError(response, fallback);
    return (await response.json().catch(() => ({}))) as T;
  }, { onWaiting: deps.onEnclaveWaiting, wait: sleep, signal: deps.signal });
}

/**
 * Chiffre et envoie le fichier, clôt l'envoi, puis attend le scellement par l'enclave. Au retour,
 * le brouillon porte sa référence et son reçu : il se publie comme un petit fichier.
 */
export async function sendChunkedDataset(
  terms: ChunkedDatasetTerms,
  source: ChunkedFileSource,
  deps: ChunkedTransferDeps,
): Promise<{ uploadId: string }> {
  const { api, signal } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  if (source.sizeBytes !== terms.sizeBytes) throw new Error("La taille du fichier a changé depuis la création du brouillon");
  const base = `/api/datasets/${encodeURIComponent(terms.datasetId)}/uploads`;

  const opened = await untilEnclaveReady<OpenedUpload>(deps, sleep, () => post(api, base, { chunkBytes: deps.chunkBytes ?? UPLOAD_CHUNK_BYTES }), "Ouverture de l’envoi refusée");
  if (opened.sizeBytes !== terms.sizeBytes) throw new Error("Taille de l’envoi incohérente");
  const ids = { datasetId: terms.datasetId, uploadId: opened.uploadId };
  const encryptor = await ChunkedUploadEncryptor.create({
    recipientPublicKey: await deps.verifyIngressKey(opened.ingressKey),
    ids,
    plainBytes: terms.sizeBytes,
    chunkBytes: opened.chunkBytes,
  });
  if (encryptor.chunkCount !== opened.chunkCount) throw new Error("Découpage de l’envoi incohérent");
  const uploadPath = `${base}/${encodeURIComponent(opened.uploadId)}`;
  try {
    return await transfer();
  } catch (error) {
    // Envoi interrompu ou refusé : on le ferme pour libérer le quota du fournisseur et supprimer
    // ses morceaux (sans effet sur un scellement en cours, que le site refuse d'abandonner).
    await api.request(uploadPath, { method: "DELETE" }).then((response) => response.body?.cancel(), () => undefined);
    throw error;
  }

  async function transfer(): Promise<{ uploadId: string }> {
    let sentBytes = 0;
    let sentChunks = 0;
    const report = () =>
      deps.onProgress?.({ phase: "upload", sentBytes, totalBytes: terms.sizeBytes, sentChunks, chunkCount: encryptor.chunkCount });
    report();

    async function presign(indexes: number[]): Promise<Map<number, string>> {
      const { parts } = await json<{ parts: { index: number; url: string }[] }>(
        await post(api, `${uploadPath}/parts`, { indexes }),
        "URL d’envoi refusées",
      );
      return new Map(parts.map((part) => [part.index, part.url]));
    }

    async function sendChunk(index: number, url: string): Promise<void> {
      const plainBytes = chunkPlainBytes(index, terms.sizeBytes, opened.chunkBytes);
      const plain = await source.read(index * opened.chunkBytes, plainBytes);
      if (plain.length !== plainBytes) throw new Error("Lecture du fichier incomplète");
      const { object } = await encryptor.encrypt(index, plain);
      let target = url;
      for (let attempt = 1; ; attempt += 1) {
        signal?.throwIfAborted();
        let status = 0;
        try {
          const response = await api.put(target, object, signal);
          await response.body?.cancel();
          if (response.ok) break;
          status = response.status;
        } catch (error) {
          if (signal?.aborted) throw error;
        }
        if (attempt >= PUT_ATTEMPTS) throw new Error(`Envoi du morceau ${index + 1} impossible${status ? ` (HTTP ${status})` : ""}`);
        // URL expirée ou refusée : nouvelle URL signée avant de réessayer.
        if (status === 403) target = (await presign([index])).get(index) ?? target;
        await sleep(1_000 * attempt);
      }
      sentBytes += plainBytes;
      sentChunks += 1;
      report();
    }

    // Lots courts : chaque URL sert dans la minute qui suit sa signature, même sur une connexion lente.
    const concurrency = Math.max(1, Math.min(deps.concurrency ?? DEFAULT_CONCURRENCY, 8));
    const batch = concurrency * 2;
    for (let start = 0; start < encryptor.chunkCount; start += batch) {
      signal?.throwIfAborted();
      const indexes = Array.from({ length: Math.min(batch, encryptor.chunkCount - start) }, (_, offset) => start + offset);
      const urls = await presign(indexes);
      const queue = [...indexes];
      await Promise.all(
        Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
          for (let index = queue.shift(); index !== undefined; index = queue.shift()) {
            const url = urls.get(index);
            if (!url) throw new Error("URL d’envoi manquante");
            await sendChunk(index, url);
          }
        }),
      );
    }

    const manifest = await encryptor.manifest();
    const manifestSha = await manifestSha256(manifest);
    deps.onProgress?.({ phase: "seal" });
    // Un grant par essai : il ne vaut qu'une minute, l'attente du démarrage peut durer plus.
    await untilEnclaveReady(deps, sleep, async () => {
      const grant = await deps.issueGrant(terms.datasetId, [
        terms.datasetId,
        opened.uploadId,
        terms.priceUsdcAtomic,
        String(terms.challengeDays),
        String(terms.sizeBytes),
        manifestSha,
        terms.model.modelId,
        terms.model.modelVersion,
        String(terms.maxRentalDays),
      ]);
      return post(api, `${uploadPath}/complete`, { manifest }, { "x-sirius-runner-grant": encodeRunnerGrantHeader(grant) });
    }, "Clôture de l’envoi refusée");

    const deadline = Date.now() + (deps.sealTimeoutMs ?? DEFAULT_SEAL_TIMEOUT_MS);
    for (;;) {
      signal?.throwIfAborted();
      await sleep(deps.pollMs ?? DEFAULT_POLL_MS);
      const state = await json<UploadState>(await api.request(uploadPath, { method: "GET" }), "Suivi de l’envoi indisponible");
      if (state.state === "SEALED") return { uploadId: opened.uploadId };
      if (state.state === "SEALING") {
        if (Date.now() > deadline) throw new Error("Le scellement prend plus de temps que prévu : reviens plus tard sur ce brouillon");
        continue;
      }
      throw new Error(state.error ?? "Scellement refusé");
    }
  }
}

/** Source navigateur : `Blob.slice`, sans jamais charger le fichier entier. */
export function blobSource(blob: Blob): ChunkedFileSource {
  return {
    sizeBytes: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  };
}
