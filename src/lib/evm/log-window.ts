/**
 * Lecture d'événements bornée en largeur de blocs.
 *
 * Les RPC refusent un `eth_getLogs` trop large : Alchemy s'arrête à 10 000 blocs, soit une
 * quarantaine de minutes sur Robinhood Chain. Une lecture « depuis le bloc du lock jusqu'au dernier »
 * échouait donc pour tout prêt réglé ou remboursé tard (prolongations en finalité complète,
 * remboursements trois jours après le lock), et le reaper ne pouvait plus clore le prêt en base.
 */
export const LOG_WINDOW_BLOCKS = BigInt(10_000);

/**
 * Dernier journal correspondant entre `fromBlock` et `toBlock` (inclus), cherché en remontant
 * depuis `toBlock` par fenêtres d'au plus `LOG_WINDOW_BLOCKS` blocs, sans jamais descendre sous `fromBlock`.
 * La résolution d'un prêt est récente quand on la cherche : la première fenêtre suffit presque
 * toujours. `undefined` si aucune fenêtre ne contient de journal.
 */
export async function findLatestLog<T>(
  fromBlock: bigint,
  toBlock: bigint,
  read: (from: bigint, to: bigint) => Promise<readonly T[]>,
): Promise<T | undefined> {
  for (let high = toBlock; high >= fromBlock; ) {
    const low = high - LOG_WINDOW_BLOCKS + BigInt(1) > fromBlock ? high - LOG_WINDOW_BLOCKS + BigInt(1) : fromBlock;
    const logs = await read(low, high);
    if (logs.length) return logs.at(-1);
    high = low - BigInt(1);
  }
  return undefined;
}
