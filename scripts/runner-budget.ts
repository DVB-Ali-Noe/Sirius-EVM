import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BudgetLedger, initializeBudgetLedger, validateBudgetPolicy } from "../src/lib/runner/budget-ledger";

const [command, ledgerPath, policyPath, ...extra] = process.argv.slice(2);
try {
  if (!ledgerPath || !policyPath || extra.length !== (command === "backup" ? 1 : 0)
    || !["init", "inspect", "export", "check", "backup", "sanitize-key-cache"].includes(command)) {
    throw new Error("Usage : pnpm runner:budget <init|inspect|export|check|sanitize-key-cache|backup> <registre.sqlite> <politique.json> [nouvelle-sauvegarde.sqlite]");
  }
  const policy = validateBudgetPolicy(JSON.parse(readFileSync(resolve(policyPath), "utf8")));
  const path = resolve(ledgerPath);
  if (command === "init") initializeBudgetLedger(path, policy);
  const ledger = new BudgetLedger(path, policy.chainId, policy.wallet);
  try {
    if (command === "backup") ledger.backup(resolve(extra[0]));
    if (command === "sanitize-key-cache") ledger.sanitizeKeyCache();
    const diagnostics = ledger.diagnostics();
    console.log(JSON.stringify(command === "export" ? ledger.accountingExport() : { policy: ledger.policy, ...diagnostics }, (_key, value) => typeof value === "bigint" ? String(value) : value, 2));
    if (command === "check" && (!diagnostics.canQuote || diagnostics.incompleteJobs
      || diagnostics.pendingTransactions.some((transaction) => transaction.ageMs >= 300000))) process.exitCode = 1;
  } finally { ledger.close(); }
} catch {
  console.error("Budget runner refusé. Vérifier la commande, la politique, les droits privés et le registre existant. Aucun registre existant n’est réinitialisé.");
  process.exitCode = 1;
}
