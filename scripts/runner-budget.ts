import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BudgetLedger, initializeBudgetLedger, validateBudgetPolicy } from "../src/lib/runner/budget-ledger";

const [command, ledgerPath, policyPath, ...extra] = process.argv.slice(2);
try {
  if (!ledgerPath || !policyPath || extra.length || !["init", "inspect"].includes(command)) {
    throw new Error("Usage : pnpm runner:budget <init|inspect> <registre.sqlite> <politique.json>");
  }
  const policy = validateBudgetPolicy(JSON.parse(readFileSync(resolve(policyPath), "utf8")));
  const path = resolve(ledgerPath);
  if (command === "init") initializeBudgetLedger(path, policy);
  const ledger = new BudgetLedger(path, policy.chainId, policy.wallet);
  try {
    console.log(JSON.stringify({ policy: ledger.policy, ...ledger.snapshot() }, (_key, value) => typeof value === "bigint" ? String(value) : value, 2));
  } finally { ledger.close(); }
} catch {
  console.error("Budget runner refusé. Vérifier la commande, la politique, les droits privés et le registre existant. Aucun registre existant n’est réinitialisé.");
  process.exitCode = 1;
}
