import "server-only";
import { createPublicClient, http, type PublicClient } from "viem";
import { resolveServerNetwork } from "./networks";

/**
 * Client de lecture EVM partagé côté serveur. Remplace `src/lib/xrpl/client.ts`.
 *
 * Différence structurante avec XRPL : plus de WebSocket, plus de connexion à
 * maintenir, plus de reconnexion à gérer. Le transport est du HTTP sans état, donc
 * le singleton ne sert qu'à réutiliser le pool de sockets — jamais à porter un état
 * de session. Les ~40 lignes de reconnexion et de retry de l'ancien client
 * disparaissent avec lui.
 */

let cached: { key: string; client: PublicClient } | null = null;

export function getPublicClient(): PublicClient {
  const { chain, rpcUrl } = resolveServerNetwork();
  const key = `${chain.id}:${rpcUrl}`;
  if (cached?.key === key) return cached.client;

  const client = createPublicClient({
    chain,
    transport: http(rpcUrl, {
      // Le séquenceur ordonne en FCFS : un retry ne « double » jamais une
      // transaction déjà soumise, il ne fait que retenter un appel réseau.
      retryCount: 3,
      retryDelay: 500,
      timeout: 20_000,
    }),
    // Multicall3 est déployé : viem regroupe les lectures parallèles en un appel.
    batch: { multicall: true },
  }) as PublicClient;

  cached = { key, client };
  return client;
}

/** Réinitialise le client — utilisé par les tests qui changent de réseau. */
export function resetPublicClient(): void {
  cached = null;
}
