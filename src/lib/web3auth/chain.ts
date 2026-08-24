import { CHAIN_NAMESPACES, type CustomChainConfig } from "@web3auth/modal";

export type ClientXrplNetwork = "mainnet" | "testnet" | "devnet";

const CHAINS: Record<ClientXrplNetwork, CustomChainConfig> = {
  mainnet: {
    chainNamespace: CHAIN_NAMESPACES.XRPL,
    chainId: "0x1",
    rpcTarget: "https://xrplcluster.com",
    wsTarget: "wss://xrplcluster.com",
    ticker: "XRP",
    tickerName: "XRP",
    displayName: "XRPL Mainnet",
    blockExplorerUrl: "https://livenet.xrpl.org",
    logo: "https://xrpl.org/favicon.ico",
    isTestnet: false,
  },
  testnet: {
    chainNamespace: CHAIN_NAMESPACES.XRPL,
    chainId: "0x2",
    rpcTarget: "https://s.altnet.rippletest.net:51234",
    wsTarget: "wss://s.altnet.rippletest.net:51233",
    ticker: "XRP",
    tickerName: "XRP",
    displayName: "XRPL Testnet",
    blockExplorerUrl: "https://testnet.xrpl.org",
    logo: "https://xrpl.org/favicon.ico",
    isTestnet: true,
  },
  devnet: {
    chainNamespace: CHAIN_NAMESPACES.XRPL,
    chainId: "0x3",
    rpcTarget: "https://s.devnet.rippletest.net:51234",
    wsTarget: "wss://s.devnet.rippletest.net:51233",
    ticker: "XRP",
    tickerName: "XRP",
    displayName: "XRPL Devnet",
    blockExplorerUrl: "https://devnet.xrpl.org",
    logo: "https://xrpl.org/favicon.ico",
    isTestnet: true,
  },
};

export function resolveClientXrplNetwork(): ClientXrplNetwork {
  const network = process.env.NEXT_PUBLIC_XRPL_NETWORK || "testnet";
  if (network !== "mainnet" && network !== "testnet" && network !== "devnet") {
    throw new Error(`NEXT_PUBLIC_XRPL_NETWORK invalide: ${network}`);
  }
  return network;
}

export function xrplChainConfig(): CustomChainConfig {
  return { ...CHAINS[resolveClientXrplNetwork()] };
}
