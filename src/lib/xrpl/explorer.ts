export type ExplorerNetwork = "mainnet" | "testnet" | "devnet";

const EXPLORERS: Record<ExplorerNetwork, string> = {
  mainnet: "https://livenet.xrpl.org",
  testnet: "https://testnet.xrpl.org",
  devnet: "https://devnet.xrpl.org",
};

export function transactionExplorerUrl(network: ExplorerNetwork, txHash: string): string {
  return `${EXPLORERS[network]}/transactions/${encodeURIComponent(txHash)}`;
}
