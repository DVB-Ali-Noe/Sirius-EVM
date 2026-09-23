import "server-only";
import { keccak256, type Address, type Hex, type PublicClient } from "viem";
import { AppError } from "@/lib/app-error";
import type { BudgetLedger } from "./budget-ledger";

const UNSENT_LEASE_MS = 5 * 60_000;

export async function reconcileRunnerTransactions(
  ledger: BudgetLedger,
  client: PublicClient,
  chainId: number,
  wallet: Address,
): Promise<void> {
  if (await client.getChainId() !== chainId) throw new AppError("RPC sur un autre réseau", 503);
  for (const operation of ledger.pendingTransactions()) {
    if (!operation.txHash) {
      ledger.failUnsentTransaction(operation.id, operation.fingerprint, UNSENT_LEASE_MS);
      continue;
    }
    const parts = /^(release|failure):(\d+):(0x[a-f0-9]{40}):(0x[a-f0-9]{64})$/.exec(operation.id);
    if (!parts || Number(parts[2]) !== chainId || !/^0x[a-f0-9]{64}$/.test(operation.txHash)) {
      throw new AppError("Intention runner hors scope : intervention requise", 503);
    }
    let receipt;
    try { receipt = await client.getTransactionReceipt({ hash: operation.txHash as Hex }); }
    catch { continue; }
    const [transaction, block, tip] = await Promise.all([
      client.getTransaction({ hash: operation.txHash as Hex }),
      client.getBlock({ blockNumber: receipt.blockNumber }),
      client.getBlockNumber({ cacheTime: 0 }),
    ]);
    if (block.hash !== receipt.blockHash || receipt.transactionHash.toLowerCase() !== operation.txHash
      || receipt.from.toLowerCase() !== wallet.toLowerCase() || receipt.to?.toLowerCase() !== parts[3]
      || transaction.from.toLowerCase() !== wallet.toLowerCase() || transaction.to?.toLowerCase() !== parts[3]
      || transaction.nonce !== operation.nonce || keccak256(transaction.input) !== operation.fingerprint) {
      throw new AppError("Transaction runner hors scope : intervention requise", 503);
    }
    if (tip - receipt.blockNumber + BigInt(1) < BigInt(ledger.policy.gas.confirmations)) continue;
    ledger.finish(operation.id, operation.fingerprint, receipt.status === "success");
  }
}
