import "server-only";
import { Wallet } from "xrpl";
import { getClient } from "./client";
import { resolveServerNetwork } from "./networks";

export type ServerRole = "verifier";

const SEED_ENV: Record<ServerRole, string> = {
  verifier: "XRPL_VERIFIER_SEED",
};

/**
 * Wallet seed-based côté serveur, réservé aux scénarios de développement.
 */
export function getServerWallet(role: ServerRole): Wallet {
  if (process.env.NODE_ENV === "production") {
    throw new Error(`Wallet serveur ${role} interdit hors environnement de développement`);
  }
  const seed = process.env[SEED_ENV[role]];
  if (!seed) throw new Error(`Seed manquante: ${SEED_ENV[role]}`);
  return Wallet.fromSeed(seed);
}

/** Crée et finance un wallet via le faucet testnet/devnet (pas de faucet sur mainnet). */
export async function fundTestnetWallet(): Promise<{ wallet: Wallet; balance: number }> {
  if (resolveServerNetwork().network === "mainnet") {
    throw new Error("fundWallet indisponible sur mainnet");
  }
  const client = await getClient();
  const { wallet, balance } = await client.fundWallet();
  return { wallet, balance };
}
