import type { BillingPolicy } from "@/lib/billing/config";
import { MODEL_REGISTRY, type ModelId } from "@/lib/models/registry";
import { computePriceBreakdown, parseAtomic, type PriceBreakdownResult } from "@/components/datasets/price";

/**
 * Tarif en vigueur tel que l'upload l'affiche (07-upload.md, étape 2) : les frais de calcul
 * par profil d'entraînement et le minimum imposé à la part du fournisseur.
 *
 * Module pur, partagé par la page serveur (qui le construit depuis la politique de
 * facturation) et le formulaire (qui l'affiche). Les montants sont des chaînes d'unités
 * atomiques, comme dans le devis ; aucun nombre à virgule n'intervient.
 */
export interface PublishedTariff {
  /** `tariffVersion` de la politique, ou `legacy-v6` quand la facturation v7 n'est pas active. */
  version: string;
  /**
   * Frais de calcul par profil : ce que le devis annoncera à l'emprunteur en plus de la part du
   * fournisseur (prix par jour × jours loués). Ils ne dépendent pas de la durée. Un profil
   * facultatif absent de la politique n'a pas de frais : il n'est pas publiable.
   */
  computeFeeAtomic: Partial<Record<ModelId, string>>;
  /**
   * Accès API inclus à toute location (D-32), par jour loué : profils dotés d'un quota API quand la
   * politique fixe `apiAccessDailyComputeAmount`. Absent pour un profil : pas d'API ajoutée.
   */
  apiAccessDailyFeeAtomic: Partial<Record<ModelId, string>>;
  /**
   * Profils tarifés dont toute location serait refusée (D-33, même règle que
   * `newRentalApiAccessDailyFee`) : pas de prix journalier de l'API, ou pas de quota
   * `apiCallsPerDay` pour le profil. La page d'upload n'annonce alors aucun total emprunteur.
   */
  unrentableModels: ModelId[];
  /** Plancher du prix par jour du fournisseur (`MIN_PRICE_USDC_ATOMIC`), refusé en dessous par la route. */
  minimumProviderAtomic: string;
  /** Décimales du jeton de règlement, pour affichage. */
  decimals: number;
}

export interface ExpectedTariffScope {
  chainId: number;
  /** Adresse du jeton de règlement, en minuscules. */
  usdc: string;
  decimals: number;
  minimumProviderAtomic: string;
}

const MODEL_IDS = Object.keys(MODEL_REGISTRY) as ModelId[];

/**
 * Frais de calcul d'un profil, exactement comme `prepareComputeQuote` (src/lib/billing/runner.ts)
 * les met dans le devis : le montant du profil, relevé au minimum de la politique.
 */
function computeFee(policy: BillingPolicy, modelId: ModelId): string | null {
  const profile = policy.profiles[modelId];
  if (!profile) return null;
  const configured = BigInt(profile.computeAmount);
  const minimum = BigInt(policy.minimumComputeAmount);
  return (configured > minimum ? configured : minimum).toString();
}

/**
 * Tarif affiché à partir d'une politique de facturation déjà validée (`validateBillingPolicy`).
 * Renvoie `null` si la politique ne vise pas la chaîne, le jeton ou la précision du serveur :
 * mieux vaut annoncer « tarif indisponible » qu'un montant d'un autre réseau.
 */
export function tariffFromPolicy(policy: BillingPolicy, expected: ExpectedTariffScope): PublishedTariff | null {
  if (policy.chainId !== expected.chainId || policy.usdc !== expected.usdc || policy.usdcDecimals !== expected.decimals) {
    return null;
  }
  if (parseAtomic(expected.minimumProviderAtomic) === null) return null;
  return {
    version: policy.tariffVersion,
    computeFeeAtomic: Object.fromEntries(MODEL_IDS.flatMap((id) => {
      const fee = computeFee(policy, id);
      return fee === null ? [] : [[id, fee]];
    })),
    // Profil tarifé doté d'un quota API (jamais la régression linéaire) : toute location inclut l'API.
    apiAccessDailyFeeAtomic: Object.fromEntries(MODEL_IDS.flatMap((id) => {
      const fee = policy.apiAccessDailyComputeAmount;
      const withApi = id !== "linear_regression" && computeFee(policy, id) !== null && policy.apiCallsPerDay[id] !== undefined;
      return withApi && fee !== undefined ? [[id, fee]] : [];
    })),
    unrentableModels: MODEL_IDS.filter((id) => computeFee(policy, id) !== null && id !== "linear_regression"
      && (policy.apiAccessDailyComputeAmount === undefined || policy.apiCallsPerDay[id] === undefined)),
    minimumProviderAtomic: expected.minimumProviderAtomic,
    decimals: expected.decimals,
  };
}

/** Sans facturation v7, l'escrow bloque le seul prix du dataset : les frais de calcul sont nuls. */
export function legacyTariff(decimals: number, minimumProviderAtomic: string): PublishedTariff | null {
  if (parseAtomic(minimumProviderAtomic) === null) return null;
  return {
    version: "legacy-v6",
    computeFeeAtomic: Object.fromEntries(MODEL_IDS.map((id) => [id, "0"])),
    apiAccessDailyFeeAtomic: {},
    unrentableModels: [],
    minimumProviderAtomic,
    decimals,
  };
}

/**
 * Décomposition affichée pour une part de fournisseur donnée (unités atomiques, prix par jour × jours) et un profil,
 * accès API inclus pour un jour.
 */
export function providerPriceBreakdown(
  tariff: PublishedTariff,
  modelId: ModelId,
  providerAtomic: string,
): PriceBreakdownResult {
  return computePriceBreakdown({
    providerAtomic,
    computeAtomic: tariff.computeFeeAtomic[modelId],
    apiAccessAtomic: tariff.apiAccessDailyFeeAtomic[modelId] ?? null,
    decimals: tariff.decimals,
    minimumAtomic: tariff.minimumProviderAtomic,
  });
}
