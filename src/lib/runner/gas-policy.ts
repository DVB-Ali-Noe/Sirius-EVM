import { AppError } from "@/lib/app-error";
import type { BudgetPolicy } from "./budget-ledger";

export function boundedGas(policy: BudgetPolicy["gas"], estimate: bigint, price: bigint, balance: bigint) {
  const gas = (estimate * BigInt(120) + BigInt(99)) / BigInt(100);
  const priceCap = BigInt(policy.maxFeePerGasWei);
  const maxFeePerGas = price * BigInt(2) < priceCap ? price * BigInt(2) : priceCap;
  if (estimate <= BigInt(0) || price <= BigInt(0) || price > priceCap || gas > BigInt(policy.maxGas)
    || gas * maxFeePerGas > BigInt(policy.maxTransactionWei) || balance < BigInt(policy.maxTransactionWei)) {
    throw new AppError("Plafond de gas dépassé ou liquidités ETH insuffisantes", 503);
  }
  return { gas, maxFeePerGas };
}
