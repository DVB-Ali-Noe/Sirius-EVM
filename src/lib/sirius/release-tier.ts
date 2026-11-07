import "server-only";
import type { Hex } from "viem";
import { getPublicClient } from "@/lib/evm/client";
import { readLoan } from "@/lib/evm/escrow";
import type { FinalityTier } from "@/lib/evm/fast-finality";
import { assertLockStable } from "@/lib/evm/finality";
import { assignLoanFinalityTier } from "./finality-tier";

export interface ReleaseLock {
  id: string;
  amountUsdcAtomic: string;
  finalityTier: FinalityTier;
  evmLoanKey: string;
  evmLockBlock: string;
  evmLockTxHash: string;
}

/**
 * Palier de finalité d'un prêt réglé sans entraînement (prolongation D-29, pack d'appels D-30),
 * décidé comme au lancement d'un entraînement (`prepareLoanResult`) : candidat lu sans écrire, garde
 * de profondeur du lock à ce palier (`pendingMessage` tant qu'elle n'est pas atteinte), puis marquage
 * dans la transaction qui contrôle les plafonds (unitaire et total en cours). Le montant décidant
 * est relu sur le contrat. Repli en finalité complète : nouvelle garde, à la profondeur complète.
 */
export async function releaseFinalityTier(lock: ReleaseLock, pendingMessage: string): Promise<FinalityTier> {
  const client = getPublicClient();
  const lockRef = { blockNumber: BigInt(lock.evmLockBlock), txHash: lock.evmLockTxHash as Hex };
  const verifyOnChainAmount = async () => (await readLoan(lock.evmLoanKey as Hex))?.amountUsdcAtomic === lock.amountUsdcAtomic;
  const candidate = await assignLoanFinalityTier(lock, verifyOnChainAmount, { dryRun: true });
  await assertLockStable(client, lockRef, candidate, pendingMessage);
  if (candidate !== "FAST") return "FULL";
  const marked = await assignLoanFinalityTier(lock, verifyOnChainAmount);
  if (marked !== "FAST") await assertLockStable(client, lockRef, "FULL", pendingMessage);
  return marked;
}
