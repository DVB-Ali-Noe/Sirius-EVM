import "server-only";
import { AppError } from "@/lib/app-error";
import type { PublicClient, TransactionReceipt } from "viem";

export function finalityPolicy(minimumConfirmations = 1) {
  const confirmations = Number(process.env.SIRIUS_EVM_CONFIRMATIONS ?? 1);
  const mode = process.env.SIRIUS_EVM_FINALITY
    ?? (process.env.NODE_ENV === "production" || process.env.EVM_NETWORK === "mainnet" ? "finalized" : "confirmations");
  if (!Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 100
    || !Number.isSafeInteger(minimumConfirmations) || minimumConfirmations < 1
    || !["confirmations", "finalized"].includes(mode)
    || (process.env.EVM_NETWORK === "mainnet" && mode !== "finalized")) {
    throw new AppError("Politique de finalité EVM invalide", 503);
  }
  return { confirmations: Math.max(confirmations, minimumConfirmations), finalized: mode === "finalized" };
}

export async function confirmedBlock(client: PublicClient, minimumConfirmations = 1) {
  const policy = finalityPolicy(minimumConfirmations);
  const tip = await client.getBlockNumber({ cacheTime: 0 });
  const number = tip - BigInt(policy.confirmations) + BigInt(1);
  if (number < BigInt(0)) throw new AppError("Profondeur de confirmation indisponible", 503);
  if (!policy.finalized) return client.getBlock({ blockNumber: number });
  const finalized = await client.getBlock({ blockTag: "finalized" });
  if (finalized.number === null || finalized.hash === null) throw new AppError("Finalité EVM indisponible", 503);
  return finalized.number <= number ? finalized : client.getBlock({ blockNumber: number });
}

export async function assertCanonicalReceipt(
  client: PublicClient,
  receipt: Pick<TransactionReceipt, "blockNumber" | "blockHash">,
  minimumConfirmations = 1,
): Promise<void> {
  const [canonical, stable] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }), confirmedBlock(client, minimumConfirmations),
  ]);
  if (!canonical.hash || canonical.hash !== receipt.blockHash || stable.number === null || stable.number < receipt.blockNumber) {
    throw new AppError("Transaction on-chain non confirmée ou réorganisée", 409);
  }
}
