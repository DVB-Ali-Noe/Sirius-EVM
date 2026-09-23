import { createWalletClient, http } from "viem";
import { getPublicClient } from "../src/lib/evm/client";
import { resolveServerNetwork } from "../src/lib/evm/networks";
import { settlementAccount } from "../src/lib/evm/runner-account";
import { runnerBudget } from "../src/lib/runner/budget";
import { reconcileRunnerTransactions } from "../src/lib/runner/transaction-recovery";
import { initEnclave } from "../src/lib/tee/dstack";

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length || !["reconcile", "rebroadcast"].includes(command)) throw new Error();
  if (process.env.TEE_MODE === "phala") await initEnclave();
  const ledger = runnerBudget();
  if (!ledger) throw new Error();
  try {
    const account = settlementAccount();
    const { chain, rpcUrl } = resolveServerNetwork();
    if (ledger.policy.wallet !== account.address.toLowerCase() || ledger.policy.chainId !== chain.id) throw new Error();
    const wallet = createWalletClient({ account, chain, transport: http(rpcUrl, { retryCount: 0, timeout: 20000 }) });
    await reconcileRunnerTransactions(ledger, getPublicClient(), chain.id, account.address,
      command === "rebroadcast" ? (serializedTransaction) => wallet.sendRawTransaction({ serializedTransaction }) : undefined);
    const pending = ledger.diagnostics().pendingTransactions;
    console.log(JSON.stringify({ pending }, null, 2));
    if (pending.length) process.exitCode = 1;
  } finally { ledger.close(); }
}

void main().catch(() => {
  console.error("Réconciliation runner refusée : vérifier réseau, identité, registre et finalité. Aucun nouveau nonce n’est signé.");
  process.exitCode = 1;
});
