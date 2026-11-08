// Tarification et signature de l'API développeurs (D-30, pass d'accès D-32). Module pur, sans
// dépendance serveur : utilisable côté navigateur, Next et runner.

export const CALL_PACK_SIZES = [100, 1000, 10000] as const;
export type CallPackSize = (typeof CALL_PACK_SIZES)[number];

export const API_KEY_MAX_PER_LOAN = 5;
export const API_REQUEST_MAX_SKEW_SECONDS = 300;
export const API_SIGNING_PREFIX = "SIRIUS-HMAC-SHA256";
/** Un pack acheté à moins d'une heure de l'échéance ne servirait presque pas : refusé avant tout paiement. */
export const PACK_MIN_RENTAL_LEFT_MS = 60 * 60_000;

export function isCallPackSize(value: unknown): value is CallPackSize {
  return (
    typeof value === "number" &&
    (CALL_PACK_SIZES as readonly number[]).includes(value)
  );
}

/** Pass d'accès API (D-32) : borne d'un devis (prolongations cumulées comprises). */
export const API_ACCESS_MAX_DAYS = 3650;
export const API_ACCESS_REQUIRED_CODE = "api_access_required";
/** Refus 403 de l'enclave et de Next : aucune journée payée ne couvre l'instant de l'appel. */
export const API_ACCESS_REQUIRED = "Accès API non payé pour cette période : active l’API (pass journalier) depuis la page Entraîner";
export const API_ACCESS_NOT_FOR_SALE_CODE = "api_access_not_for_sale";
/** Tarif sans `apiAccessDailyComputeAmount` : aucun pass en vente, donc aucune API (jamais gratuite). */
export const API_ACCESS_NOT_FOR_SALE = "Accès API non proposé par le tarif en vigueur : aucun pass n’est en vente pour le moment";
/** Même tarif refusé pour un nouvel emprunt : toute location inclut l'API (D-32), elle n'est donc pas louable. */
export const RENTAL_API_ACCESS_NOT_FOR_SALE = "Location indisponible : le tarif en vigueur ne fixe pas le prix journalier de l’accès API, inclus dans toute location";
export const API_ACCESS_ALREADY_PAID = "Accès API déjà payé jusqu’à l’échéance de la location";
export const API_ACCESS_IN_FLIGHT = "Un pass d’accès API est déjà en cours de paiement : il s’active dès la confirmation du réseau";
export const API_ACCESS_PREPARING = "Un pass d’accès API est déjà en préparation : termine ou abandonne son paiement, puis réessaie dans quelques minutes";
export const API_ACCESS_STALE_CODE = "api_access_stale";
/**
 * Refus définitif d'un pass verrouillé dont la base du prix a changé avant son règlement (autre
 * pass payé, location prolongée) : rien n'est versé, le paiement reste remboursable à l'échéance.
 */
export const API_ACCESS_STALE = "Pass d’accès API caduc : la couverture payée a changé depuis son devis ou un autre pass est en cours de règlement ; rien n’est versé, le paiement est remboursable à l’échéance de l’escrow";
const DAY_MS = 86_400_000;

/**
 * Jours d'accès API à payer pour couvrir la location jusqu'à son échéance : `ceil((échéance −
 * max(maintenant, couverture actuelle)) / 1 jour)`. `0` : déjà couverte jusqu'à l'échéance, ou
 * location échue.
 */
export function apiAccessDaysFor(rentalExpiresAt: number, paidUntil: number | null, now: number): number {
  const start = Math.max(now, paidUntil ?? 0);
  if (!Number.isSafeInteger(rentalExpiresAt) || rentalExpiresAt <= start) return 0;
  return Math.ceil((rentalExpiresAt - start) / DAY_MS);
}

export function isApiAccessDays(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= API_ACCESS_MAX_DAYS;
}

/** Part fournisseur d'un pass : le minimum du contrat (`MIN_AMOUNT` = 10^(décimales − 3)), le lock refusant un montant nul. */
export function apiAccessDatasetAmount(usdcDecimals: number): string {
  if (!Number.isInteger(usdcDecimals) || usdcDecimals < 3 || usdcDecimals > 30) throw new Error("Précision du jeton invalide.");
  return (BigInt(10) ** BigInt(usdcDecimals - 3)).toString();
}

/** Frais Sirius d'un pass : jours × tarif journalier de l'accès API. */
export function apiAccessComputeAmount(dailyFeeAtomic: string, days: number): string {
  if (!isApiAccessDays(days)) throw new Error("Nombre de jours d'accès API invalide.");
  return (BigInt(days) * parsePositiveAtomic(dailyFeeAtomic, "Le tarif journalier de l'API")).toString();
}

function parsePositiveAtomic(value: string, label: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error(`${label} doit être un entier atomique.`);
  }
  const parsed = BigInt(value);
  if (parsed <= BigInt(0)) {
    throw new Error(`${label} doit être strictement positif.`);
  }
  return parsed;
}

function assertCallsPerDay(callsPerDay: number): void {
  if (
    !Number.isSafeInteger(callsPerDay) ||
    callsPerDay < 1 ||
    callsPerDay > 10_000
  ) {
    throw new Error("Le quota d'appels par jour doit être un entier entre 1 et 10 000.");
  }
}

// Prix d'un appel, arrondi au supérieur : ceil(prix par jour / appels par jour).
export function pricePerCallAtomic(
  priceUsdcAtomic: string,
  callsPerDay: number,
): string {
  const price = parsePositiveAtomic(priceUsdcAtomic, "Le prix par jour");
  assertCallsPerDay(callsPerDay);
  const calls = BigInt(callsPerDay);
  return ((price + calls - BigInt(1)) / calls).toString();
}

// Montant fournisseur d'un pack : taille × prix par appel.
export function packDatasetAmount(
  priceUsdcAtomic: string,
  callsPerDay: number,
  size: number,
): string {
  if (!isCallPackSize(size)) {
    throw new Error("Taille de pack d'appels invalide.");
  }
  return (
    BigInt(size) * BigInt(pricePerCallAtomic(priceUsdcAtomic, callsPerDay))
  ).toString();
}

export type ApiCanonicalInput = {
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  bodySha256Hex: string;
};

// Chaîne signée par HMAC-SHA256 : une valeur par ligne, séparées par "\n".
export function apiCanonicalString(input: ApiCanonicalInput): string {
  if (!Number.isSafeInteger(input.timestamp)) {
    throw new Error("L'horodatage doit être un entier en secondes.");
  }
  const queryIndex = input.path.indexOf("?");
  const path = queryIndex === -1 ? input.path : input.path.slice(0, queryIndex);
  return [
    API_SIGNING_PREFIX,
    input.method.toUpperCase(),
    path,
    String(input.timestamp),
    input.nonce,
    input.bodySha256Hex.toLowerCase(),
  ].join("\n");
}
