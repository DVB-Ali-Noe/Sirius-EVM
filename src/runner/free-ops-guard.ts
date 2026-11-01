/**
 * Garde des opérations runner non facturées (`UNCHARGED_OPS` : `dataset-ingress-key`, audit ROB-08).
 *
 * Elles ne coûtent rien au budget, mais pas rien au runner : chaque appel consomme sa capability
 * dans l'anti-rejeu SQLite (écriture synchronisée, fsync). `node:sqlite` est synchrone : pendant ces
 * écritures, la boucle d'événements est bloquée pour toutes les requêtes, payantes comprises.
 *
 * Trois bornes, toutes propres à ces opérations :
 * - un seau à jetons par opération (débit soutenu et rafale) : au-delà, 429 sans rien écrire ;
 * - une concurrence à part : elles ne prennent jamais une place des opérations payantes ;
 * - un coupe-circuit sur le temps passé à les traiter : si leur temps cumulé dépasse une part de la
 *   fenêtre (disque lent, rafale, runner chargé), elles sont suspendues quelques secondes (503).
 *
 * Le runner ne voit qu'un client, Next (derrière la passerelle Phala) : une limite par IP ou par
 * wallet n'a pas de sens ici. Les limites par wallet restent côté Next ; celle-ci borne le total,
 * quel que soit le nombre d'instances Next.
 */

export interface FreeOpsPolicy {
  /** Jetons rendus par minute, pour chaque opération gratuite. */
  perMinute: number;
  /** Capacité du seau : rafale admise après un temps calme. */
  burst: number;
  /** Opérations gratuites traitées en même temps, hors plafond des opérations payantes. */
  concurrency: number;
  /** Fenêtre d'observation du coupe-circuit. */
  breakerWindowMs: number;
  /** Temps de traitement cumulé admis par fenêtre avant d'ouvrir le coupe-circuit. */
  breakerBusyMs: number;
  /** Durée de suspension une fois le coupe-circuit ouvert. */
  breakerCooldownMs: number;
}

export const DEFAULT_FREE_OPS_POLICY: FreeOpsPolicy = {
  perMinute: 60,
  burst: 10,
  concurrency: 2,
  breakerWindowMs: 10_000,
  breakerBusyMs: 3_000,
  breakerCooldownMs: 30_000,
};

export const FREE_OPS_RATE_LIMITED = "Trop d’opérations gratuites : réessayer dans quelques secondes";
export const FREE_OPS_SUSPENDED = "Opérations gratuites suspendues : runner sous charge";

export type FreeOpsDecision =
  | { admitted: true; release: () => void }
  | { admitted: false; status: 429 | 503; error: string; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class FreeOpsGuard {
  private readonly buckets = new Map<string, Bucket>();
  private active = 0;
  private windowStart: number;
  private busyMs = 0;
  private openUntil = 0;

  constructor(
    readonly policy: FreeOpsPolicy = DEFAULT_FREE_OPS_POLICY,
    private readonly now: () => number = () => performance.now(),
  ) {
    validateFreeOpsPolicy(policy);
    this.windowStart = now();
  }

  admit(op: string): FreeOpsDecision {
    const now = this.now();
    if (now < this.openUntil) {
      return { admitted: false, status: 503, error: FREE_OPS_SUSPENDED, retryAfterSeconds: secondsUntil(this.openUntil - now) };
    }
    if (this.active >= this.policy.concurrency) {
      return { admitted: false, status: 503, error: "Runner saturé", retryAfterSeconds: 1 };
    }
    const bucket = this.refill(op, now);
    if (bucket.tokens < 1) {
      const perMs = this.policy.perMinute / 60_000;
      return { admitted: false, status: 429, error: FREE_OPS_RATE_LIMITED, retryAfterSeconds: secondsUntil((1 - bucket.tokens) / perMs) };
    }
    bucket.tokens -= 1;
    this.active += 1;
    const started = now;
    let released = false;
    return {
      admitted: true,
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.record(this.now() - started);
      },
    };
  }

  /** État lisible par la supervision et les tests. */
  state(): { active: number; busyMs: number; open: boolean } {
    return { active: this.active, busyMs: this.busyMs, open: this.now() < this.openUntil };
  }

  private refill(op: string, now: number): Bucket {
    const bucket = this.buckets.get(op) ?? { tokens: this.policy.burst, updatedAt: now };
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.policy.burst, bucket.tokens + (elapsed * this.policy.perMinute) / 60_000);
    bucket.updatedAt = now;
    this.buckets.set(op, bucket);
    return bucket;
  }

  private record(durationMs: number): void {
    const now = this.now();
    if (now - this.windowStart >= this.policy.breakerWindowMs) {
      this.windowStart = now;
      this.busyMs = 0;
    }
    this.busyMs += Math.max(0, durationMs);
    if (this.busyMs > this.policy.breakerBusyMs) {
      this.openUntil = now + this.policy.breakerCooldownMs;
      this.windowStart = now;
      this.busyMs = 0;
      console.warn(
        `[runner] coupe-circuit des opérations gratuites ouvert pour ${Math.round(this.policy.breakerCooldownMs / 1000)} s ` +
          "(temps de traitement au-dessus du seuil)",
      );
    }
  }
}

function secondsUntil(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

export function validateFreeOpsPolicy(policy: FreeOpsPolicy): void {
  const integer = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (!integer(policy.perMinute, 1, 600) || !integer(policy.burst, 1, 100) || !integer(policy.concurrency, 1, 8)
    || !integer(policy.breakerWindowMs, 1_000, 60_000) || !integer(policy.breakerCooldownMs, 1_000, 600_000)
    || !integer(policy.breakerBusyMs, 1, policy.breakerWindowMs - 1)) {
    throw new Error("Politique des opérations gratuites du runner invalide");
  }
}

function setting(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} doit être un entier entre ${min} et ${max}`);
  }
  return value;
}

/** Valeurs prudentes par défaut, ajustables par l'environnement (Compose attesté). */
export function freeOpsPolicyFromEnv(env: Record<string, string | undefined> = process.env): FreeOpsPolicy {
  const d = DEFAULT_FREE_OPS_POLICY;
  const breakerWindowMs = setting(env, "RUNNER_FREE_OPS_BREAKER_WINDOW_MS", d.breakerWindowMs, 1_000, 60_000);
  const policy: FreeOpsPolicy = {
    perMinute: setting(env, "RUNNER_FREE_OPS_PER_MINUTE", d.perMinute, 1, 600),
    burst: setting(env, "RUNNER_FREE_OPS_BURST", d.burst, 1, 100),
    concurrency: setting(env, "RUNNER_FREE_OPS_CONCURRENCY", d.concurrency, 1, 8),
    breakerWindowMs,
    breakerBusyMs: setting(env, "RUNNER_FREE_OPS_BREAKER_BUSY_MS", Math.min(d.breakerBusyMs, breakerWindowMs - 1), 1, breakerWindowMs - 1),
    breakerCooldownMs: setting(env, "RUNNER_FREE_OPS_BREAKER_COOLDOWN_MS", d.breakerCooldownMs, 1_000, 600_000),
  };
  validateFreeOpsPolicy(policy);
  return policy;
}
