/**
 * Démarrage de l'enclave (D-30) vu du navigateur et de la CLI : les routes wallet qui ont besoin du
 * runner (création de clé, prédiction depuis le site, achat d'appels, devis d'emprunt ou de
 * prolongation, publication d'un dataset) répondent
 * `503 { error: { code: "enclave_starting", message }, retryAfterSeconds }` tant que la CVM
 * démarre, sans rien avoir écrit. L'appelant explique l'attente et relance seul, dans une limite de temps.
 */

export const ENCLAVE_STARTING_CODE = "enclave_starting";
export const ENCLAVE_STARTING_MESSAGE = "L’enclave démarre. La demande reprendra dès qu’elle sera prête.";
/** Au-delà, l'attente s'arrête et l'erreur s'affiche (démarrage habituel : quelques minutes). */
export const ENCLAVE_WAIT_MAX_MS = 10 * 60_000;
const DEFAULT_RETRY_SECONDS = 15;
const MAX_RETRY_SECONDS = 120;

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export class EnclaveStartingError extends Error {
  readonly code = ENCLAVE_STARTING_CODE;
  constructor(readonly retryAfterSeconds: number) {
    super(ENCLAVE_STARTING_MESSAGE);
    this.name = "EnclaveStartingError";
  }
}

function retrySeconds(body: { retryAfterSeconds?: unknown } | null, header: string | null): number {
  const candidates = [body?.retryAfterSeconds, header === null ? undefined : Number(header)];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.min(Math.ceil(value), MAX_RETRY_SECONDS);
  }
  return DEFAULT_RETRY_SECONDS;
}

/**
 * Erreur lisible d'une réponse en échec : `{ error: string }` (routes historiques) ou
 * `{ error: { code, message } }` (routes D-30). Un 503 `enclave_starting` devient
 * `EnclaveStartingError`, pour que l'appelant attende au lieu d'afficher une panne.
 */
export async function responseError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => null) as { error?: unknown; code?: unknown; retryAfterSeconds?: unknown } | null;
  const error = body?.error;
  const nested = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : null;
  const code = nested?.code ?? body?.code;
  if (response.status === 503 && code === ENCLAVE_STARTING_CODE) {
    return new EnclaveStartingError(retrySeconds(body, response.headers.get("Retry-After")));
  }
  if (typeof error === "string" && error) return new Error(error);
  if (typeof nested?.message === "string" && nested.message) return new Error(nested.message);
  return new Error(fallback);
}

/**
 * Relance `run` tant qu'il échoue sur `EnclaveStartingError`, en respectant `Retry-After`,
 * jusqu'à `maxWaitMs`. `onWaiting(seconds)` annonce chaque attente, `onWaiting(null)` sa fin.
 */
export async function retryWhileEnclaveStarts<T>(
  run: () => Promise<T>,
  {
    onWaiting,
    maxWaitMs = ENCLAVE_WAIT_MAX_MS,
    wait = sleep,
    now = () => Date.now(),
  }: {
    onWaiting?: (retryInSeconds: number | null) => void;
    maxWaitMs?: number;
    wait?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<T> {
  const deadline = now() + maxWaitMs;
  try {
    for (;;) {
      try {
        return await run();
      } catch (error) {
        if (!(error instanceof EnclaveStartingError)) throw error;
        const delayMs = error.retryAfterSeconds * 1000;
        if (now() + delayMs > deadline) throw error;
        onWaiting?.(error.retryAfterSeconds);
        await wait(delayMs);
      }
    }
  } finally {
    onWaiting?.(null);
  }
}
