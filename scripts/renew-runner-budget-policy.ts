import { renewSponsoredBudgetPolicy } from "../src/lib/runner/budget-ledger";
import { runnerVolumeNetwork } from "./initialize-runner-volume";

/** Acteur journalisé dans `sponsored_policy_changes` pour une prolongation de maintenance. */
export const RENEWAL_ACTOR = "maintenance:renew-budget-policy";

if (process.argv[1]?.endsWith("/renew-runner-budget-policy.ts")) {
  try {
    if (process.argv.length !== 3 || process.env.RUNNER_VOLUME_ACTION !== "renew-budget-policy") throw new Error();
    const target = runnerVolumeNetwork(process.env.EVM_NETWORK);
    const wallet = process.env.SIRIUS_LOCK_AUTHORIZER?.trim() ?? "";
    const result = renewSponsoredBudgetPolicy(process.argv[2], target.chainId, wallet,
      JSON.parse(process.env.RUNNER_BUDGET_RENEWAL ?? ""), RENEWAL_ACTOR);
    const until = new Date(result.next.validUntil).toISOString();
    console.log(result.status === "renewed"
      ? `Budget prolongé : ${new Date(result.previous.validUntil).toISOString()} → ${until}. Compteurs, réservations et anti-rejeu inchangés.`
      : `Prolongation jusqu'à ${until} déjà appliquée : rien n'a été réécrit.`);
  } catch {
    console.error("Prolongation du budget refusée : contrôler le volume, le réseau, le wallet, la date (plus tardive, au plus 31 jours après le relevé) et le relevé du financement. Rien n'a été modifié ; ne pas réinitialiser le volume.");
    process.exitCode = 1;
  }
}
