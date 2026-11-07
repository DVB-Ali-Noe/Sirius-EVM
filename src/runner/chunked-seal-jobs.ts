import "server-only";
import { AppError } from "@/lib/app-error";
import { RunnerRetryLater } from "@/lib/runner/failure-policy";
import { r2ConfigFromEnv, r2GetObject, type R2Config } from "@/lib/storage/r2";
import { chunkObjectKey, type UploadIds } from "@/lib/upload/chunked";
import type { AuthorizedSealDatasetResult } from "@/lib/tee/contract";
import type { ChunkSource } from "@/lib/tee/core";

/**
 * Scellements en arrière-plan des datasets envoyés en morceaux (jusqu'à 1 Gio).
 *
 * Relire, déchiffrer et valider 1 Gio dépasse le délai d'une requête du runner (65 s) : la requête
 * signée par le fournisseur lance le scellement et rend la main, Next suit ensuite son état par
 * une opération de lecture. L'état vit en mémoire : un runner redémarré oublie ses scellements en
 * cours, Next le voit (« inconnu ») et le fournisseur relance la clôture avec un nouveau grant.
 */

export type ChunkedSealState =
  | { state: "sealing"; startedAt: number }
  | { state: "sealed"; result: AuthorizedSealDatasetResult }
  | { state: "failed"; error: string; status: number; retryable: boolean };

interface Job {
  state: ChunkedSealState;
  finishedAt?: number;
}

/** Un seul gros scellement à la fois : il occupe le processeur de la CVM pendant une minute ou plus. */
const MAX_ACTIVE_SEALS = 1;
const SEAL_TIMEOUT_MS = 20 * 60_000;
const FINISHED_TTL_MS = 60 * 60_000;
const MAX_TRACKED_JOBS = 256;

function jobKey({ datasetId, uploadId }: UploadIds): string {
  return `${datasetId}:${uploadId}`;
}

function failure(error: unknown): Extract<ChunkedSealState, { state: "failed" }> {
  if (error instanceof AppError) {
    return { state: "failed", error: error.message, status: error.status, retryable: error.status >= 500 };
  }
  console.error("[runner] scellement en morceaux : erreur interne");
  return { state: "failed", error: "Scellement interrompu : réessaie", status: 500, retryable: true };
}

export class ChunkedSealJobs {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private purge(): void {
    for (const [key, job] of this.jobs) {
      if (job.finishedAt !== undefined && this.now() - job.finishedAt > FINISHED_TTL_MS) this.jobs.delete(key);
    }
  }

  private active(): number {
    let count = 0;
    for (const job of this.jobs.values()) if (job.state.state === "sealing") count += 1;
    return count;
  }

  /**
   * Lance le scellement et rend la main tout de suite. Refuse un deuxième scellement du même envoi
   * pendant le premier, un envoi déjà scellé, et tout scellement quand un autre est en cours.
   */
  start(ids: UploadIds, run: (signal: AbortSignal) => Promise<AuthorizedSealDatasetResult>): ChunkedSealState {
    this.purge();
    const key = jobKey(ids);
    const existing = this.jobs.get(key);
    if (existing?.state.state === "sealing") throw new AppError("Scellement déjà en cours pour cet envoi", 409);
    if (existing?.state.state === "sealed") throw new AppError("Envoi déjà scellé", 409);
    if (this.active() >= MAX_ACTIVE_SEALS) {
      throw new RunnerRetryLater("Un autre scellement est en cours : réessaie dans quelques minutes");
    }
    if (!existing && this.jobs.size >= MAX_TRACKED_JOBS) throw new RunnerRetryLater("Runner saturé : réessaie plus tard");

    const job: Job = { state: { state: "sealing", startedAt: this.now() } };
    this.jobs.set(key, job);
    const signal = AbortSignal.timeout(SEAL_TIMEOUT_MS);
    void Promise.resolve()
      .then(() => run(signal))
      .then(
        (result) => {
          job.state = { state: "sealed", result };
        },
        (error: unknown) => {
          job.state = signal.aborted
            ? { state: "failed", error: "Scellement trop long : réessaie", status: 503, retryable: true }
            : failure(error);
        },
      )
      .finally(() => {
        job.finishedAt = this.now();
      });
    return job.state;
  }

  status(ids: UploadIds): ChunkedSealState {
    this.purge();
    const job = this.jobs.get(jobKey(ids));
    if (!job) throw new AppError("Scellement inconnu de ce runner : relance la clôture de l’envoi", 404);
    return job.state;
  }
}

export const chunkedSeals = new ChunkedSealJobs();

/** Identifiants R2 du runner (jeton en lecture seule), lus dans sa configuration attestée. */
export function chunkedStorageConfig(env: Record<string, string | undefined> = process.env): R2Config {
  try {
    return r2ConfigFromEnv(env);
  } catch {
    throw new AppError("Envoi en morceaux indisponible sur ce runner", 503);
  }
}

/**
 * Morceaux relus dans R2. Un morceau absent est la faute de l'envoi (refus) ; un stockage
 * injoignable ne l'est pas : le scellement pourra être relancé sans renvoyer les morceaux.
 */
export function r2SealSource(config: R2Config, ids: UploadIds, signal: AbortSignal, fetchImpl?: typeof fetch): ChunkSource {
  return {
    async readChunk(index) {
      try {
        return await r2GetObject(config, chunkObjectKey(ids, index), { signal, fetchImpl });
      } catch (error) {
        if (signal.aborted) throw error;
        const message = error instanceof Error ? error.message : "";
        if (message.includes("HTTP 404")) throw new AppError(`Morceau ${index} absent du stockage`, 400);
        if (message.includes("HTTP 403")) throw new AppError("Stockage refusé au runner", 503);
        throw new RunnerRetryLater("Stockage momentanément injoignable : réessaie dans quelques minutes");
      }
    },
  };
}
