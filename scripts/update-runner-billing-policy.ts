import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { validateBillingPolicy, type BillingPolicy } from "../src/lib/billing/config";
import { readBudgetPolicy } from "../src/lib/runner/budget-ledger";
import { runnerVolumeNetwork, type RunnerVolumeNetwork } from "./initialize-runner-volume";

export interface BillingPolicyUpdate {
  previousTariffVersion: string;
  tariffVersion: string;
  addedProfiles: string[];
  changedProfiles: string[];
  backup: string;
  /** SHA-256 des octets écrits, égal à celui du JSON fourni et publié par `/operations/budget`. */
  sha256: string;
}

/**
 * Remplace le tarif d'un volume runner déjà initialisé, sans toucher au registre budgétaire ni à
 * l'anti-rejeu. Même chaîne, même jeton, même précision et même trésorerie que le tarif installé ;
 * aucun profil retiré (un dataset publié sous ce profil ne pourrait plus être devisé) ; un profil
 * installé ne change de prix qu'avec `allowProfileChanges` ; validité bornée par la politique du
 * registre budgétaire réel. Les octets fournis sont écrits tels quels ; l'ancien fichier est
 * conservé en 0600 à côté.
 */
export function updateRunnerBillingPolicy(
  budgetDirectory: string,
  nextJson: string,
  target: RunnerVolumeNetwork,
  { now = Date.now(), allowProfileChanges = false }: { now?: number; allowProfileChanges?: boolean } = {},
): BillingPolicyUpdate {
  if (!isAbsolute(budgetDirectory) || !lstatSync(budgetDirectory).isDirectory()) throw new Error("Volume budget existant requis");
  const path = join(budgetDirectory, "billing-policy.json");
  const current = JSON.parse(readFileSync(path, "utf8")) as BillingPolicy;
  const budget = readBudgetPolicy(join(budgetDirectory, "ledger.sqlite"));
  const next = validateBillingPolicy(JSON.parse(nextJson));
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
  if ((changedProfiles.length || next.minimumComputeAmount !== current.minimumComputeAmount) && !allowProfileChanges) {
    throw new Error("Prix d'un profil installé modifié : option explicite requise");
  }

  const write = (file: string, content: string) => {
    const fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  };
  const staged = `${path}.next`;
  // Un fichier préparé par une tentative interrompue n'a jamais remplacé le tarif : il est jeté.
  rmSync(staged, { force: true });
  const backup = join(budgetDirectory, `billing-policy.previous-${now}.json`);
  try {
    write(backup, readFileSync(path, "utf8"));
    write(staged, nextJson);
    renameSync(staged, path);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
  const directory = openSync(budgetDirectory, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
  return {
    previousTariffVersion: current.tariffVersion, tariffVersion: next.tariffVersion, addedProfiles, changedProfiles, backup,
    sha256: createHash("sha256").update(nextJson).digest("hex"),
  };
}

if (process.argv[1]?.endsWith("/update-runner-billing-policy.ts")) {
  try {
    if (process.argv.length !== 3 || process.env.RUNNER_VOLUME_ACTION !== "update-billing-policy") throw new Error();
    const target = runnerVolumeNetwork(process.env.EVM_NETWORK);
    const nextJson = process.env.RUNNER_UPDATED_BILLING_POLICY ?? "";
    const next = validateBillingPolicy(JSON.parse(nextJson));
    if (next.usdc !== process.env.SIRIUS_USDC_ADDRESS?.trim().toLowerCase()
      || next.computeRecipient !== process.env.SIRIUS_COMPUTE_RECIPIENT?.trim().toLowerCase()) throw new Error();
    const result = updateRunnerBillingPolicy(process.argv[2], nextJson, target,
      { allowProfileChanges: process.env.RUNNER_BILLING_ALLOW_PROFILE_CHANGES === "true" });
    console.log(`Tarif ${result.previousTariffVersion} → ${result.tariffVersion} (sha256 ${result.sha256}) ; profils ajoutés : ${result.addedProfiles.join(", ") || "aucun"} ; modifiés : ${result.changedProfiles.join(", ") || "aucun"}. Ancien tarif conservé. Réactiver le runner avec le Compose actif.`);
  } catch {
    console.error("Mise à jour du tarif refusée : contrôler le volume, la chaîne, le jeton, la trésorerie, les profils et la validité du budget. Rien n'a été remplacé ; ne pas réinitialiser le volume.");
    process.exitCode = 1;
  }
}
