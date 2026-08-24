export type XrplNetwork = "mainnet" | "testnet" | "devnet";

export const XRPL_ENDPOINTS: Record<XrplNetwork, string> = {
  mainnet: "wss://xrplcluster.com",
  testnet: "wss://s.altnet.rippletest.net:51233",
  devnet: "wss://s.devnet.rippletest.net:51233",
};

export const XRPL_HTTP_ENDPOINTS: Record<XrplNetwork, string> = {
  mainnet: "https://xrplcluster.com",
  testnet: "https://s.altnet.rippletest.net:51234",
  devnet: "https://s.devnet.rippletest.net:51234",
};

/** Réseau + endpoint côté serveur (API routes), pilotés par .env. */
export function resolveServerNetwork(): { network: XrplNetwork; wsUrl: string } {
  const raw = process.env.XRPL_NETWORK || "testnet";
  if (!(raw in XRPL_ENDPOINTS)) {
    throw new Error(
      `XRPL_NETWORK invalide: "${raw}" (attendu: ${Object.keys(XRPL_ENDPOINTS).join(", ")})`,
    );
  }
  const network = raw as XrplNetwork;
  const wsUrl = process.env.XRPL_ENDPOINT || XRPL_ENDPOINTS[network];
  return { network, wsUrl };
}
