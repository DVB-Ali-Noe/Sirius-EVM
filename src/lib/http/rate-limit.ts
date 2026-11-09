import { AppError } from "@/lib/app-error";

interface FixedWindowRateLimiterOptions {
  windowMs: number;
  maxPerKey: number;
  maxGlobal: number;
  maxTrackedKeys?: number;
}

interface Window {
  count: number;
  startedAt: number;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();
  private global: Window = { count: 0, startedAt: 0 };

  constructor(private readonly options: FixedWindowRateLimiterOptions) {}

  consume(key: string | null, now = Date.now()): boolean {
    const { windowMs, maxPerKey, maxGlobal, maxTrackedKeys = 1_024 } = this.options;
    if (this.global.startedAt <= now - windowMs) this.global = { count: 0, startedAt: now };
    if (this.global.count >= maxGlobal) return false;

    if (key === null) {
      this.global.count += 1;
      return true;
    }

    let effectiveKey = key;
    if (!this.windows.has(effectiveKey) && this.windows.size >= maxTrackedKeys) {
      for (const [candidate, window] of this.windows) {
        if (window.startedAt <= now - windowMs) this.windows.delete(candidate);
      }
      if (this.windows.size >= maxTrackedKeys) effectiveKey = "overflow";
    }

    const current = this.windows.get(effectiveKey);
    const keyWindow = !current || current.startedAt <= now - windowMs
      ? { count: 0, startedAt: now }
      : current;
    if (keyWindow.count >= maxPerKey) return false;

    keyWindow.count += 1;
    this.global.count += 1;
    this.windows.set(effectiveKey, keyWindow);
    return true;
  }

  /**
   * Ce qui refuserait `key` maintenant, sans rien compter (refus anticipé quand le décompte n'est
   * fait qu'après coup) : sa propre fenêtre (`"own"`), le seau commun `overflow` où tomberait une
   * clé non suivie quand toutes les places sont prises par des fenêtres encore ouvertes
   * (`"overflow"`), ou le plafond de l'instance (`"global"`) ; `null` si rien ne la refuse.
   */
  blockedBy(key: string | null, now = Date.now()): "own" | "overflow" | "global" | null {
    const { windowMs, maxPerKey, maxGlobal, maxTrackedKeys = 1_024 } = this.options;
    const full = (window: Window | undefined, max: number) => window !== undefined && window.startedAt > now - windowMs && window.count >= max;
    if (full(this.global, maxGlobal)) return "global";
    if (key === null) return null;
    if (this.windows.has(key)) return full(this.windows.get(key), maxPerKey) ? "own" : null;
    if (this.windows.size < maxTrackedKeys) return null;
    for (const window of this.windows.values()) if (window.startedAt <= now - windowMs) return null;
    return full(this.windows.get("overflow"), maxPerKey) ? "overflow" : null;
  }
}

export function requestClientKey(req: Request, fallback?: string): string | null {
  if (process.env.SIRIUS_TRUST_PROXY_HEADERS !== "true") {
    return fallback ? `subject:${fallback}` : null;
  }
  const value = req.headers.get("x-real-ip")?.trim();
  if (!value || !/^[A-Fa-f0-9:.]{3,64}$/.test(value)) {
    throw new AppError("Adresse client transmise par l’ingress invalide", 400);
  }
  return `ip:${value.toLowerCase()}`;
}

/**
 * Réseau d'une clé `requestClientKey` : une adresse IPv6 compte pour son /64 (un client en obtient
 * couramment un entier et y fait tourner ses adresses), une IPv4 (ou IPv4 mappée) pour elle-même.
 */
export function clientNetworkKey(client: string): string {
  if (!client.startsWith("ip:") || !client.includes(":", 3)) return client;
  const address = client.slice(3);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return `ip:${mapped[1]}`;
  const [head, tail] = address.split("::");
  const groups = (part: string | undefined) => part ? part.split(":").flatMap((group) => group.includes(".") ? ["0", "0"] : [group]) : [];
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const all = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `ip6:${all.slice(0, 4).map((group) => (parseInt(group || "0", 16) || 0).toString(16)).join(":")}::/64`;
}

export function enforceRateLimit(limiter: FixedWindowRateLimiter, key: string | null): void {
  if (!limiter.consume(key)) throw new AppError("Trop de requêtes — réessaie plus tard", 429);
}
