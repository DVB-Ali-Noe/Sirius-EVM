import { readFileSync } from "node:fs";

export function estimateScenario(plan, scenario) {
  if (![plan.diskGb, scenario.retentionHours, scenario.runningHours, scenario.successfulJobs].every(Number.isSafeInteger)
    || plan.diskGb < 20 || scenario.runningHours < 0 || scenario.retentionHours < scenario.runningHours || scenario.successfulJobs < 1) {
    throw new Error("Hypothèses de coûts invalides");
  }
  const compute = BigInt(plan.computeUsdMicrosPerHour) * BigInt(scenario.runningHours);
  const storage = BigInt(plan.diskUsdMicrosPerGbHour) * BigInt(plan.diskGb) * BigInt(scenario.retentionHours);
  if (compute < 0n || storage < 0n) throw new Error("Coûts négatifs refusés");
  const jobs = BigInt(scenario.successfulJobs);
  const total = compute + storage;
  const perJob = (total + jobs - 1n) / jobs;
  return { name: scenario.name, computeUsdMicros: String(compute), storageUsdMicros: String(storage),
    totalPhalaUsdMicros: String(total), breakEvenPhalaPerSuccessUsdMicros: String(perJob),
    minimumWith25PercentBufferUsdCents: String((total * 125n + jobs * 1000000n - 1n) / (jobs * 1000000n)) };
}

export function estimatePlan(plan) {
  return { status: "draft", activationReady: false, chainId: plan.chainId, computeRecipient: plan.computeRecipient,
    runner: plan.runner, excluded: ["Pinata", "Vercel", "Neon", "VPS", "RPC", "taxes", "change USD/USDC"],
    spendingCapUsdMicros: plan.spendingCapUsdMicros,
    scenarios: plan.scenarios.map((scenario) => estimateScenario(plan, scenario)),
    note: "Hypothèses de fréquentation ; aucune vente garantie. Les tokens testnet ne financent pas les fournisseurs. Aucune politique active créée." };
}

if (process.argv[1]?.endsWith("/costs.mjs")) {
  try { console.log(JSON.stringify(estimatePlan(JSON.parse(readFileSync(process.argv[2] || "deploy/operations/testnet-plan.json", "utf8"))), null, 2)); }
  catch { console.error("Estimation refusée : vérifier les hypothèses explicites."); process.exitCode = 1; }
}
