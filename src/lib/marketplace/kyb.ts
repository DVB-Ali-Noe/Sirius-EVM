import "server-only";
import { tryNormalizeAddress } from "@/lib/evm/address";

/**
 * Statut KYB des fournisseurs pour l'affichage public de la marketplace.
 *
 * La source de vérité est le registre on-chain (`isKybValid`), comme pour l'emprunt lui-même
 * (`src/lib/sirius/access.ts`). Ici le statut n'est qu'un badge et un filtre d'affichage : il
 * ne garde rien. Une lecture lente ou en panne ne doit donc ni bloquer la page ni afficher
 * « vérifié » à tort : délai court, statut `null` (inconnu) en cas d'échec, cache borné.
 */

export type KybReader = (address: `0x${string}`) => Promise<boolean>;

const CACHE_TTL_MS = 60_000;
/** Un échec est retenu moins longtemps, pour ne pas marteler un RPC en panne sans figer l'erreur. */
const FAILURE_TTL_MS = 10_000;
const MAX_CACHE_ENTRIES = 1_024;
/** Adresses lues par requête ; les suivantes restent « inconnues » (le catalogue de la bêta est loin de ce seuil). */
export const MAX_KYB_LOOKUPS = 200;
export const KYB_LOOKUP_TIMEOUT_MS = 2_500;

interface CacheEntry {
  verified: boolean | null;
  expiresAt: number;
}

export function createKybStatusReader(
  read: KybReader,
  options: { timeoutMs?: number; now?: () => number; maxLookups?: number } = {},
) {
  const cache = new Map<string, CacheEntry>();
  const timeoutMs = options.timeoutMs ?? KYB_LOOKUP_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const maxLookups = options.maxLookups ?? MAX_KYB_LOOKUPS;

  function remember(address: string, verified: boolean | null) {
    if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(address)) {
      cache.delete(cache.keys().next().value as string);
    }
    cache.set(address, { verified, expiresAt: now() + (verified === null ? FAILURE_TTL_MS : CACHE_TTL_MS) });
  }

  async function readWithTimeout(address: `0x${string}`): Promise<boolean | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      // `then` plutôt qu'un appel direct : une exception synchrone du lecteur devient un rejet.
      const lookup = Promise.resolve().then(() => read(address)).then((value) => value === true);
      return await Promise.race([lookup, timeout]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return async function kybStatuses(addresses: readonly string[]): Promise<Map<string, boolean | null>> {
    const result = new Map<string, boolean | null>();
    const pending: Array<{ key: string; address: `0x${string}` }> = [];
    for (const raw of new Set(addresses)) {
      const address = tryNormalizeAddress(raw);
      if (!address) {
        result.set(raw, null);
        continue;
      }
      const cached = cache.get(address);
      if (cached && cached.expiresAt > now()) {
        result.set(raw, cached.verified);
      } else if (pending.length < maxLookups) {
        pending.push({ key: raw, address });
      } else {
        result.set(raw, null);
      }
    }
    const read = await Promise.all(pending.map(async ({ key, address }) => [key, address, await readWithTimeout(address)] as const));
    for (const [key, address, verified] of read) {
      remember(address, verified);
      result.set(key, verified);
    }
    return result;
  };
}
