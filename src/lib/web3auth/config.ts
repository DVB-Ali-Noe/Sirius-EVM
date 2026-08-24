import { WEB3AUTH_NETWORK, type Web3AuthOptions } from "@web3auth/modal";
import { XrplPrivateKeyProvider } from "@web3auth/modal/providers/xrpl-provider";
import { resolveClientXrplNetwork, xrplChainConfig } from "./chain";

/**
 * Options du singleton `Web3Auth` (piloté en impératif, cf lib/web3auth/manager).
 * Appelée uniquement côté client (le SDK touche `window`) → `window.location.origin`
 * est sûr ici. `keyExportEnabled: false` → la clé ne sort jamais du provider : on
 * signe via `xrpl_signTransaction` in-provider (non-custodial dur, cf D-20).
 */
export function buildWeb3AuthOptions(): Web3AuthOptions {
  const clientId = process.env.NEXT_PUBLIC_WEB3AUTH_CLIENT_ID;
  if (!clientId) throw new Error("NEXT_PUBLIC_WEB3AUTH_CLIENT_ID manquant");

  // Le provider ping `rpcTarget` en HTTP à l'init → on le route par notre proxy
  // same-origin (rippled testnet n'a pas de CORS). Voir /api/xrpl-rpc.
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const rpcTarget = `${origin}/api/xrpl-rpc`;

  // Clones indépendants : le provider gèle sa copie de la chaîne, tandis que le
  // core y écrit `id` lors de la normalisation. Une référence partagée → une des
  // deux écritures casse ("Cannot assign to read only property 'id'").
  const chain = xrplChainConfig();
  const providerChain = { ...structuredClone(chain), rpcTarget };
  const optionsChain = { ...structuredClone(chain), rpcTarget };

  const expectedWeb3AuthNetwork = resolveClientXrplNetwork() === "mainnet"
    ? WEB3AUTH_NETWORK.SAPPHIRE_MAINNET
    : WEB3AUTH_NETWORK.SAPPHIRE_DEVNET;
  const configuredWeb3AuthNetwork = process.env.NEXT_PUBLIC_WEB3AUTH_NETWORK;
  if (configuredWeb3AuthNetwork && configuredWeb3AuthNetwork !== expectedWeb3AuthNetwork) {
    throw new Error("NEXT_PUBLIC_WEB3AUTH_NETWORK ne correspond pas au réseau XRPL");
  }

  const privateKeyProvider = new XrplPrivateKeyProvider({
    config: { chain: providerChain, chains: [providerChain], keyExportEnabled: false },
  });

  return {
    clientId,
    web3AuthNetwork: expectedWeb3AuthNetwork,
    chains: [optionsChain],
    defaultChainId: optionsChain.chainId,
    privateKeyProvider,
    ssr: false,
  };
}
