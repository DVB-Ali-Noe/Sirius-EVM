// Tarification et signature de l'API développeurs (D-30). Module pur, sans
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
