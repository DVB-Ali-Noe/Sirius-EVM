/**
 * Location des modèles de prêt (D-29) : bornes et calculs partagés par le Next, le runner et
 * l'interface. Module pur (aucun import), utilisable côté client.
 */

export const MIN_RENTAL_DAYS = 1;
export const MAX_RENTAL_DAYS = 365;
/** Durée maximale d'un dataset publié avant D-29 (colonne par défaut, reçu v3). */
export const DEFAULT_MAX_RENTAL_DAYS = 30;
/** Délai après l'échéance pendant lequel le modèle reste scellé et prolongeable. */
export const RENTAL_GRACE_DAYS = 30;
export const DAY_MS = 86_400_000;

/** Nombre entier de jours dans `[MIN_RENTAL_DAYS, min(max, MAX_RENTAL_DAYS)]`. */
export function isValidRentalDays(days: unknown, max: number = MAX_RENTAL_DAYS): days is number {
  return typeof days === "number" && Number.isSafeInteger(days) && days >= MIN_RENTAL_DAYS
    && days <= Math.min(max, MAX_RENTAL_DAYS);
}

/** Montant dataset d'une location : prix par jour (USDC atomique) × nombre de jours. */
export function datasetAmountFor(priceUsdcAtomic: string, rentalDays: number): string {
  if (!/^(0|[1-9][0-9]{0,28})$/.test(priceUsdcAtomic) || !isValidRentalDays(rentalDays)) {
    throw new RangeError("Prix par jour ou durée de location invalide");
  }
  return (BigInt(priceUsdcAtomic) * BigInt(rentalDays)).toString();
}
