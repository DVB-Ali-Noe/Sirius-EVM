import { AppError } from "@/lib/app-error";
import { type Hex, keccak256 } from "viem";
import type { BudgetLedger, WorkflowBudget } from "./budget-ledger";

export interface BudgetedTransactionIO {
  prepare(): Promise<{ serialized: Hex; nonce: number }>;
  send(serialized: Hex): Promise<Hex>;
  confirm(hash: Hex): Promise<"success" | "reverted" | "pending">;
  seal?(serialized: Hex): string;
}

export async function sendBudgetedTransaction(
  ledger: BudgetLedger,
  id: string,
  fingerprint: string,
  io: BudgetedTransactionIO,
  workflow?: WorkflowBudget,
): Promise<Hex> {
  const { fresh, operation } = ledger.reserve(id, fingerprint, "transaction", workflow);
  if (operation.state === "succeeded" && operation.txHash) return operation.txHash as Hex;
  if (operation.state === "failed") throw new AppError("Tentative de règlement épuisée", 503);
  let hash = operation.txHash as Hex | null;
  if (fresh) {
    let prepared;
    try {
      prepared = await io.prepare();
    } catch {
      ledger.finish(id, fingerprint, false);
      throw new AppError("Règlement refusé avant envoi : vérifier budget et réseau", 503);
    }
    hash = keccak256(prepared.serialized);
    // Le hash signé et le nonce sont durables AVANT le premier appel d’envoi RPC.
    try {
      ledger.recordTransaction(id, fingerprint, hash, prepared.nonce, io.seal?.(prepared.serialized));
    } catch (error) {
      ledger.failUnsentTransaction(id, fingerprint);
      throw error;
    }
    try {
      const receivedHash = await io.send(prepared.serialized);
      if (receivedHash.toLowerCase() !== hash) throw new Error("RPC hash mismatch");
    } catch {
      // Un timeout ne prouve pas l’absence de diffusion ; seule la confirmation clôt l’intention.
    }
  }
  if (!hash) throw new AppError("Intention runner interrompue : réconciliation manuelle requise", 503);
  let status: "success" | "reverted" | "pending" = "pending";
  try { status = await io.confirm(hash); } catch { /* L’engagement reste réservé. */ }
  if (status === "pending") throw new AppError("Transaction runner incertaine : nouvel envoi bloqué", 503);
  ledger.finish(id, fingerprint, status === "success");
  if (status === "reverted") throw new AppError("Règlement on-chain rejeté : aucune relance automatique", 502);
  return hash;
}
