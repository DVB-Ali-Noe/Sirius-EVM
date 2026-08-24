import { defineChain, type Chain } from "viem";

/**
 * Réseaux EVM cibles de Sirius : Robinhood Chain, un L2 Arbitrum Nitro.
 *
 * Valeurs vérifiées en direct le 14/08/2026 par sondes RPC :
 *   testnet 46630 (0xb626) · mainnet 4663 (0x1237)
 *   client `nitro/v3.11.3-rc.9` · gas en ETH natif
 *   baseFee 0,01 gwei et `maxPriorityFeePerGas` à 0 — le séquenceur ordonne en
 *   FCFS strict, donc surenchérir sur le gas n'accélère jamais une inclusion.
 *   Multicall3 déployé à l'adresse canonique.
 *
 * Les deux environnements partagent les mêmes conventions de résolution réseau.
 */

export type EvmNetwork = "mainnet" | "testnet";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export const robinhoodMainnet: Chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: {
    multicall3: { address: MULTICALL3 },
  },
});

export const robinhoodTestnet: Chain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://explorer.testnet.chain.robinhood.com" },
  },
  contracts: {
    multicall3: { address: MULTICALL3 },
  },
  testnet: true,
});

export const EVM_CHAINS: Record<EvmNetwork, Chain> = {
  mainnet: robinhoodMainnet,
  testnet: robinhoodTestnet,
};

export const EVM_CHAIN_IDS: Record<EvmNetwork, number> = {
  mainnet: robinhoodMainnet.id,
  testnet: robinhoodTestnet.id,
};

function parseNetwork(raw: string, variable: string): EvmNetwork {
  if (raw !== "mainnet" && raw !== "testnet") {
    throw new Error(`${variable} invalide: "${raw}" (attendu: mainnet, testnet)`);
  }
  return raw;
}

/** Réseau + RPC côté serveur (API routes et runner), pilotés par l'environnement. */
export function resolveServerNetwork(): { network: EvmNetwork; chain: Chain; rpcUrl: string } {
  const network = parseNetwork(process.env.EVM_NETWORK || "testnet", "EVM_NETWORK");
  const chain = EVM_CHAINS[network];
  const rpcUrl = process.env.EVM_RPC_URL || chain.rpcUrls.default.http[0];
  return { network, chain, rpcUrl };
}

/** Réseau attendu côté navigateur. Doit correspondre au serveur, sinon les signatures sont rejetées. */
export function resolveClientNetwork(): EvmNetwork {
  return parseNetwork(process.env.NEXT_PUBLIC_EVM_NETWORK || "testnet", "NEXT_PUBLIC_EVM_NETWORK");
}

export function chainForNetwork(network: EvmNetwork): Chain {
  return EVM_CHAINS[network];
}
