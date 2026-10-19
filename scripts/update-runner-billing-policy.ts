import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { validateBillingPolicy, type BillingPolicy } from "../src/lib/billing/config";
import { validateBudgetPolicy } from "../src/lib/runner/budget-ledger";
import { runnerVolumeNetwork, type RunnerVolumeNetwork } from "./initialize-runner-volume";

export interface BillingPolicyUpdate {
  previousTariffVersion: string;
  tariffVersion: string;
  addedProfiles: string[];
  changedProfiles: string[];
  backup: string;
}

/**
 * Remplace le tarif d'un volume runner déjà initialisé, sans toucher au registre budgétaire ni à
 * l'anti-rejeu. Même chaîne, même jeton, même précision et même trésorerie que le tarif installé ;
 * aucun profil retiré (un dataset publié sous ce profil ne pourrait plus être devisé) ; validité
 * bornée par celle de la politique budgétaire. L'ancien fichier est conservé en 0600 à côté.
 */
export function updateRunnerBillingPolicy(
  budgetDirectory: string,
  nextValue: unknown,
  target: RunnerVolumeNetwork,
  now = Date.now(),
): BillingPolicyUpdate {
  if (!isAbsolute(budgetDirectory) || !lstatSync(budgetDirectory).isDirectory()) throw new Error("Volume budget existant requis");
  const path = join(budgetDirectory, "billing-policy.json");
  const current = JSON.parse(readFileSync(path, "utf8")) as BillingPolicy;
  const budget = validateBudgetPolicy(JSON.parse(readFileSync(join(budgetDirectory, "budget-policy.json"), "utf8")));
  const next = validateBillingPolicy(nextValue);
  if (next.chainId !== target.chainId || next.usdcDecimals !== target.usdcDecimals
    || next.chainId !== current.chainId || next.usdc !== current.usdc || next.usdcDecimals !== current.usdcDecimals
    || next.computeRecipient !== current.computeRecipient || budget.chainId !== next.chainId) {
    throw new Error("Le nouveau tarif ne vise pas la même chaîne, le même jeton ou la même trésorerie");
  }
  if (next.validUntil > budget.validUntil) throw new Error("Le tarif ne peut pas survivre à la politique budgétaire");
  if (next.tariffVersion === current.tariffVersion) throw new Error("Nouvelle version de tarif requise");
  const removed = Object.keys(current.profiles ?? {}).filter((id) => !Object.hasOwn(next.profiles, id));
  if (removed.length) throw new Error("Aucun profil installé ne peut être retiré");
  for (const profile of Object.values(next.profiles)) {
    if (!profile) continue;
    const amount = BigInt(profile.computeAmount) > BigInt(next.minimumComputeAmount)
      ? BigInt(profile.computeAmount) : BigInt(next.minimumComputeAmount);
    if (BigInt(profile.maxFailureFee) > amount) throw new Error("Retenue supérieure au prix compute");
  }
  const profileIds = Object.keys(next.profiles) as (keyof BillingPolicy["profiles"])[];
  const addedProfiles = profileIds.filter((id) => !Object.hasOwn(current.profiles ?? {}, id));
  const changedProfiles = profileIds.filter((id) => Object.hasOwn(current.profiles ?? {}, id)
    && JSON.stringify(current.profiles[id]) !== JSON.stringify(next.profiles[id]));

  const write = (file: string, content: string) => {
    const fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  };
  const backup = join(budgetDirectory, `billing-policy.previous-${now}.json`);
  write(backup, readFileSync(path, "utf8"));
  const staged = `${path}.next`;
  write(staged, JSON.stringify(next));
  renameSync(staged, path);
  const directory = openSync(budgetDirectory, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
  return { previousTariffVersion: current.tariffVersion, tariffVersion: next.tariffVersion, addedProfiles, changedProfiles, backup };
}

if (process.argv[1]?.endsWith("/update-runner-billing-policy.ts")) {
  try {
    if (process.argv.length !== 3 || process.env.RUNNER_VOLUME_ACTION !== "update-billing-policy") throw new Error();
    const target = runnerVolumeNetwork(process.env.EVM_NETWORK);
    const next = validateBillingPolicy(JSON.parse(process.env.RUNNER_UPDATED_BILLING_POLICY ?? ""));
    if (next.usdc !== process.env.SIRIUS_USDC_ADDRESS?.trim().toLowerCase()
      || next.computeRecipient !== process.env.SIRIUS_COMPUTE_RECIPIENT?.trim().toLowerCase()) throw new Error();
    const result = updateRunnerBillingPolicy(process.argv[2], next, target);
    console.log(`Tarif ${result.previousTariffVersion} → ${result.tariffVersion} ; profils ajoutés : ${result.addedProfiles.join(", ") || "aucun"} ; modifiés : ${result.changedProfiles.join(", ") || "aucun"}. Ancien tarif conservé. Réactiver le runner avec le Compose actif.`);
  } catch {
    console.error("Mise à jour du tarif refusée : contrôler le volume, la chaîne, le jeton, la trésorerie et les profils. Rien n'a été remplacé ; ne pas réinitialiser le volume.");
    process.exitCode = 1;
  }
}
