import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { validateBillingPolicy } from "../src/lib/billing/config";
import { initializeBudgetLedger, validateBudgetPolicy } from "../src/lib/runner/budget-ledger";
import { initializeRunnerReplay } from "../src/lib/runner/replay";

export function initializeRunnerVolume(root: string, budgetValue: unknown, billingValue: unknown): void {
  const budget = validateBudgetPolicy(budgetValue);
  const billing = validateBillingPolicy(billingValue);
  if (!isAbsolute(root) || budget.chainId !== 46630 || billing.chainId !== 46630 || billing.usdcDecimals !== 18
    || budget.wallet === billing.computeRecipient || /^0x0{40}$/.test(billing.computeRecipient) || /^0x0{40}$/.test(billing.usdc)
    || budget.validUntil <= Date.now() || budget.validUntil < billing.validUntil
    || BigInt(budget.earnedMarginUsdMicros) <= BigInt(budget.fixedReserveUsdMicros)
    || BigInt(budget.cashUsdMicros) <= BigInt(budget.fixedReserveUsdMicros) || BigInt(budget.gas.totalWei) === BigInt(0)
    || BigInt(budget.gas.maxTransactionWei) < BigInt(budget.gas.maxGas) * BigInt(budget.gas.maxFeePerGasWei)) {
    throw new Error("Politiques de première installation incompatibles ou non financées");
  }
  for (const profile of Object.values(billing.profiles)) {
    const amount = BigInt(profile.computeAmount) > BigInt(billing.minimumComputeAmount)
      ? BigInt(profile.computeAmount) : BigInt(billing.minimumComputeAmount);
    if (BigInt(profile.maxFailureFee) > amount) throw new Error("Retenue supérieure au prix compute");
  }
  const budgetDirectory = join(root, "budget");
  const replayDirectory = join(root, "replay");
  for (const directory of [budgetDirectory, replayDirectory]) {
    if (!lstatSync(directory).isDirectory()) throw new Error("Volumes locaux existants requis");
  }
  if (readdirSync(budgetDirectory).length || readdirSync(replayDirectory).some((name) => !["grant", "capability"].includes(name))) {
    throw new Error("Volume déjà initialisé ou incomplet : restauration opérateur requise");
  }
  // Les anciens volumes d'amorçage étaient créés en 0755 ; seul leur accès est resserré.
  for (const directory of [budgetDirectory, replayDirectory]) chmodSync(directory, 0o700);
  const writePolicy = (name: string, policy: unknown) => {
    const fd = openSync(join(budgetDirectory, name), "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(policy)); fsyncSync(fd); } finally { closeSync(fd); }
  };
  initializeRunnerReplay(replayDirectory);
  writePolicy("budget-policy.json", budget);
  writePolicy("billing-policy.json", billing);
  initializeBudgetLedger(join(budgetDirectory, "ledger.sqlite"), budget);
}

if (process.argv[1]?.endsWith("/initialize-runner-volume.ts")) {
  try {
    if (process.argv.length !== 3 || process.env.RUNNER_VOLUME_ACTION !== "initialize-new-v7-volume") throw new Error();
    const budget = validateBudgetPolicy(JSON.parse(process.env.RUNNER_INITIAL_BUDGET_POLICY ?? ""));
    const billing = validateBillingPolicy(JSON.parse(process.env.RUNNER_INITIAL_BILLING_POLICY ?? ""));
    if (budget.wallet !== process.env.SIRIUS_LOCK_AUTHORIZER?.trim().toLowerCase()
      || billing.usdc !== process.env.SIRIUS_USDC_ADDRESS?.trim().toLowerCase()
      || billing.computeRecipient !== process.env.SIRIUS_COMPUTE_RECIPIENT?.trim().toLowerCase()) throw new Error();
    initializeRunnerVolume(process.argv[2], budget, billing);
    console.log("Volumes v7 initialisés. Retirer le Compose d'initialisation avant toute activation métier.");
  } catch {
    console.error("Initialisation refusée : contrôler les volumes et les politiques approuvées. Aucun fichier existant écrasé ; ne pas supprimer un état partiel pour recommencer.");
    process.exitCode = 1;
  }
}
