import "server-only";
import { verifyTdxQuote, type QuoteVerification } from "@/lib/tee/quote";
import type { CertificateRecord } from "./resolve";
import type { VerificationOutcome } from "./presentation";

/**
 * Vérification bornée de la quote TDX pour la page publique du certificat.
 *
 * La vérification matérielle (`getCollateralAndVerify`) va chercher la collatérale Intel
 * sur le réseau. Une page publique qui la déclencherait à chaque affichage servirait
 * d'amplificateur : chaque requête anonyme coûterait des appels sortants. D'où :
 *
 * - un cache par prêt et par hash d'attestation (une heure si la vérification a abouti,
 *   cinq minutes si elle n'a pas pu conclure, une minute en cas d'erreur) ;
 * - une seule vérification en vol par prêt (les visiteurs simultanés l'attendent) ;
 * - un plafond global de vérifications neuves par fenêtre : au-delà, la page affiche
 *   « en attente » sans rien appeler ;
 * - un délai maximal d'attente : au-delà, la page s'affiche avec « en attente », et la
 *   vérification en cours remplit le cache pour l'affichage suivant.
 *
 * Les contrôles locaux (report data, mesures, rejeu de l'event-log) ne touchent pas le
 * réseau ; ils sont calculés une fois et mis en cache de la même façon, pour que la page
 * affiche les mesures même quand la vérification matérielle est en attente.
 *
 * Le cache est propre au processus : sur une plateforme qui multiplie les instances,
 * le plafond s'applique par instance (voir la section N6 de l'audit).
 */

const QUOTE_HEX = /^[0-9a-fA-F]+$/;
/** Une quote TDX v4 avec sa chaîne de certificats PCK tient en quelques kilo-octets. */
export const MAX_QUOTE_HEX_LENGTH = 64 * 1024;

export interface VerificationInput {
  quote: string;
  payloadHash: string;
  evidence?: { eventLog: string; composeHash: string };
}

type Verify = (input: VerificationInput, skipHardware: boolean) => Promise<QuoteVerification>;

export interface BoundedVerifierOptions {
  verify: Verify;
  now?: () => number;
  /** Résultat matériel concluant (vérifié ou TCB refusé avec un statut). */
  conclusiveTtlMs?: number;
  /** Vérification aboutie sans conclusion matérielle (collatérale injoignable, signature refusée). */
  inconclusiveTtlMs?: number;
  /** La vérification a levé une erreur (quote illisible, mesure épinglée invalide). */
  failureTtlMs?: number;
  maxEntries?: number;
  /** Vérifications matérielles neuves autorisées par fenêtre, toutes pages confondues. */
  maxFreshPerWindow?: number;
  windowMs?: number;
  /** Attente maximale d'une vérification matérielle pendant le rendu. */
  timeoutMs?: number;
}

interface Entry {
  expiresAt: number;
  value: QuoteVerification | null;
}

class BoundedCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly maxEntries: number) {}

  get(key: string, now: number): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, entry: Entry): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
  }

  get size(): number {
    return this.entries.size;
  }
}

function isWellFormed(input: VerificationInput): boolean {
  return (
    input.quote.length > 0 &&
    input.quote.length <= MAX_QUOTE_HEX_LENGTH &&
    input.quote.length % 2 === 0 &&
    QUOTE_HEX.test(input.quote)
  );
}

export class BoundedQuoteVerifier {
  private readonly verify: Verify;
  private readonly now: () => number;
  private readonly conclusiveTtlMs: number;
  private readonly inconclusiveTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly maxFreshPerWindow: number;
  private readonly windowMs: number;
  private readonly timeoutMs: number;
  private readonly full: BoundedCache;
  private readonly local: BoundedCache;
  private readonly inFlight = new Map<string, Promise<Entry>>();
  private window = { startedAt: 0, count: 0 };

  constructor(options: BoundedVerifierOptions) {
    this.verify = options.verify;
    this.now = options.now ?? Date.now;
    this.conclusiveTtlMs = options.conclusiveTtlMs ?? 60 * 60_000;
    this.inconclusiveTtlMs = options.inconclusiveTtlMs ?? 5 * 60_000;
    this.failureTtlMs = options.failureTtlMs ?? 60_000;
    this.maxFreshPerWindow = options.maxFreshPerWindow ?? 10;
    this.windowMs = options.windowMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    const maxEntries = options.maxEntries ?? 500;
    this.full = new BoundedCache(maxEntries);
    this.local = new BoundedCache(maxEntries);
  }

  /** Nombre d'entrées en cache (tests). */
  get cachedEntries(): number {
    return this.full.size + this.local.size;
  }

  private consumeFresh(now: number): boolean {
    if (this.window.startedAt <= now - this.windowMs) this.window = { startedAt: now, count: 0 };
    if (this.window.count >= this.maxFreshPerWindow) return false;
    this.window.count += 1;
    return true;
  }

  private ttlFor(value: QuoteVerification): number {
    if (value.hardwareVerified === true) return this.conclusiveTtlMs;
    if (value.hardwareVerified === false && value.tcbStatus !== undefined) return this.conclusiveTtlMs;
    if (value.hardwareVerified === null) return this.conclusiveTtlMs; // simulateur : rien d'externe
    return this.inconclusiveTtlMs;
  }

  private async localChecks(key: string, input: VerificationInput): Promise<VerificationOutcome> {
    const now = this.now();
    const cached = this.local.get(key, now);
    if (cached) return cached.value ? { status: "pending", verification: cached.value } : { status: "error" };
    let value: QuoteVerification | null;
    try {
      value = await this.verify(input, true);
    } catch {
      value = null;
    }
    this.local.set(key, { expiresAt: now + (value ? this.conclusiveTtlMs : this.failureTtlMs), value });
    return value ? { status: "pending", verification: value } : { status: "error" };
  }

  private start(key: string, input: VerificationInput): Promise<Entry> {
    const running = (async (): Promise<Entry> => {
      try {
        const value = await this.verify(input, false);
        const entry = { expiresAt: this.now() + this.ttlFor(value), value };
        this.full.set(key, entry);
        return entry;
      } catch {
        const entry = { expiresAt: this.now() + this.failureTtlMs, value: null };
        this.full.set(key, entry);
        return entry;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, running);
    return running;
  }

  private async wait(running: Promise<Entry>): Promise<Entry | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.timeoutMs);
    });
    try {
      return await Promise.race([running, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async check(key: string, input: VerificationInput): Promise<VerificationOutcome> {
    // Rien d'invalide ne part vers la collatérale Intel.
    if (!isWellFormed(input)) return { status: "error" };

    const cached = this.full.get(key, this.now());
    if (cached) return cached.value ? { status: "complete", verification: cached.value } : { status: "error" };

    let running = this.inFlight.get(key);
    if (!running) {
      if (!this.consumeFresh(this.now())) return this.localChecks(key, input);
      running = this.start(key, input);
    }
    const entry = await this.wait(running);
    if (!entry) return this.localChecks(key, input);
    return entry.value ? { status: "complete", verification: entry.value } : { status: "error" };
  }
}

const globalForVerifier = globalThis as unknown as { siriusCertificateVerifier?: BoundedQuoteVerifier };

function certificateVerifier(): BoundedQuoteVerifier {
  globalForVerifier.siriusCertificateVerifier ??= new BoundedQuoteVerifier({
    verify: (input, skipHardware) =>
      verifyTdxQuote(input.quote, input.payloadHash, input.evidence, skipHardware ? { skipHardware: true } : {}),
  });
  return globalForVerifier.siriusCertificateVerifier;
}

/** Résultat affichable de la vérification pour un certificat prêt. */
export async function verifyCertificate(record: CertificateRecord): Promise<VerificationOutcome> {
  const { quote, payloadHash, eventLog, composeHash } = record.evidence;
  if (!quote) return { status: "absent" };
  const evidence = eventLog && composeHash ? { eventLog, composeHash } : undefined;
  return certificateVerifier().check(`${record.loanId}:${payloadHash}`, { quote, payloadHash, evidence });
}
