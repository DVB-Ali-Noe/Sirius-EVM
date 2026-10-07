import "server-only";
import { AppError } from "@/lib/app-error";
import type { Hex, PublicClient, TransactionReceipt } from "viem";
import { estimateLockFinality, type LockFinalityEstimate } from "./lock-finality";

export function finalityPolicy(minimumConfirmations = 1) {
  const confirmations = Number(process.env.SIRIUS_EVM_CONFIRMATIONS ?? 1);
  const mode = process.env.SIRIUS_EVM_FINALITY
    ?? (process.env.NODE_ENV === "production" || process.env.EVM_NETWORK === "mainnet" ? "finalized" : "confirmations");
  if (!Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 100
    || !Number.isSafeInteger(minimumConfirmations) || minimumConfirmations < 1 || minimumConfirmations > 100
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

/**
 * Refuse d'avancer tant qu'un bloc n'est pas sous la profondeur stable (le bloc finalisé
 * sur mainnet). Le runner lit l'escrow à cette profondeur : l'appeler plus tôt ne ferait
 * que consommer un crédit du devis pour une réponse « escrow inactif ».
 */
export async function assertBlockStable(client: PublicClient, blockNumber: bigint, message: string): Promise<void> {
  const stable = await confirmedBlock(client);
  if (stable.number === null || stable.number < blockNumber) throw new AppError(message, 409);
}

/**
 * Même profondeur stable qu'`assertBlockStable`, mais pour informer : le lock est-il déjà sous
 * le bloc stable, et sinon dans combien de temps, d'après l'écart entre les horodatages du lock
 * et du bloc stable (voir lock-finality.ts). Deux lectures RPC, aucune transaction.
 */
export async function lockFinalityStatus(client: PublicClient, lockBlock: bigint, now = Date.now()): Promise<LockFinalityEstimate> {
  const [stable, lock] = await Promise.all([confirmedBlock(client), client.getBlock({ blockNumber: lockBlock })]);
  if (stable.number === null) throw new AppError("Finalité EVM indisponible", 503);
  return estimateLockFinality(
    { lockBlock, lockTimestamp: lock.timestamp, stableBlock: stable.number, stableTimestamp: stable.timestamp },
    now,
  );
}

export async function checkRpcFinality(client: PublicClient, chainId: number, transactionHash?: Hex) {
  if (await client.getChainId() !== chainId) throw new AppError("RPC sur un autre réseau", 503);
  const policy = finalityPolicy();
  const stable = await confirmedBlock(client);
  if (stable.number === null || !stable.hash) throw new AppError("Bloc confirmé indisponible", 503);
  const [tip, canonical] = await Promise.all([
    client.getBlockNumber({ cacheTime: 0 }), client.getBlock({ blockNumber: stable.number }),
  ]);
  if (stable.number > tip || canonical.number !== stable.number || canonical.hash !== stable.hash) {
    throw new AppError("Vue RPC incohérente ou réorganisée", 503);
  }
  let receiptStatus: "success" | "reverted" | null = null;
  if (transactionHash) {
    const receipt = await client.getTransactionReceipt({ hash: transactionHash });
    if (receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) throw new AppError("Reçu RPC hors scope", 503);
    await assertCanonicalReceipt(client, receipt);
    receiptStatus = receipt.status;
  }
  return { chainId, policy, latestBlock: String(tip), confirmedBlock: String(stable.number), confirmedHash: stable.hash,
    lagBlocks: String(tip - stable.number), transactionHash: transactionHash ?? null, receiptStatus };
}
