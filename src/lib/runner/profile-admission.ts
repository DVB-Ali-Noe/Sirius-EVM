import { AppError } from "@/lib/app-error";
import { isModelOffered, modelSelection, type ModelSelection } from "@/lib/models/registry";

export const OPT_IN_PROFILE_DISABLED = "Profil d’entraînement facultatif non activé sur ce runner";

/**
 * Profil demandé au runner.
 *
 * `offered` : nouveau dépôt, devis ou self-train. Un profil facultatif est refusé tant que le
 * Compose ne l'active pas (`NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS`, rendu par `--opt-in-models`).
 *
 * `locked` : prêt déjà payé (`run-loan-job`). L'interrupteur n'est pas relu à la lecture de la
 * requête : `assertLockedProfile` décide une fois le devis vérifié. Sans cela, couper
 * l'interrupteur après un lock laissait les fonds bloqués jusqu'à l'échéance (audit PAR-01, REP-07).
 */
export type ProfileAdmission = "offered" | "locked";

export function requestedTrainingProfile(body: Record<string, unknown>, admission: ProfileAdmission = "offered"): ModelSelection {
  const selection = modelSelection(body.modelId, body.modelVersion);
  if (!selection) throw new AppError("Modèle ou version non autorisé", 400);
  if (admission === "offered" && !isModelOffered(selection.modelId)) throw new AppError(OPT_IN_PROFILE_DISABLED, 400);
  return selection;
}

/**
 * Prêt verrouillé dont le profil n'est plus proposé : il est exécuté si l'enclave a elle-même
 * signé le devis de ce prêt pour ce profil. `runnerComputeQuote` vérifie la signature et la copie
 * gardée dans son registre, `assertQuoteDataset` lie le devis au profil du dataset ; or l'enclave
 * ne signe un devis qu'après `requestedTrainingProfile(…, "offered")`. Le profil était donc
 * proposé quand l'acheteur a payé : on livre ce qui a été payé, ou, si le calcul échoue, le
 * remboursement immédiat `Failed` s'applique comme pour tout prêt v7.
 *
 * Un prêt v6 (sans devis) garde le refus : aucun profil facultatif n'y est tarifé.
 */
export function assertLockedProfile(
  selection: ModelSelection,
  signedQuote: { quote: { modelId: string; modelVersion: string } } | undefined,
  optInModels?: string,
): void {
  // `undefined` laisse `isModelOffered` lire l'environnement du runner.
  if (isModelOffered(selection.modelId, optInModels)) return;
  if (signedQuote?.quote.modelId === selection.modelId && signedQuote.quote.modelVersion === selection.modelVersion) return;
  throw new AppError(OPT_IN_PROFILE_DISABLED, 400);
}
