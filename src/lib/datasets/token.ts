import { USDC_DECIMALS_BY_NETWORK, type EvmNetwork } from "@/lib/evm/networks";
import type { TokenInfo } from "@/components/datasets/price";

/**
 * Jeton de règlement affiché par l'upload, selon le réseau : USDG (Paxos) sur mainnet
 * (01-decisions-avant-samedi.md §1), USDC de test sur le testnet Robinhood. Les décimales
 * sont celles de la table de `networks.ts`, dont `contracts/scripts/deploy.ts` vérifie la
 * valeur on-chain au déploiement.
 *
 * Il n'existe pas encore de fabrique centrale du jeton (audit A2 §8) : celle-ci ne sert
 * que l'upload et pourra être remplacée par la fabrique de la slice USDG.
 */
export function settlementToken(network: EvmNetwork): TokenInfo {
  return { symbol: network === "mainnet" ? "USDG" : "USDC", decimals: USDC_DECIMALS_BY_NETWORK[network] };
}
