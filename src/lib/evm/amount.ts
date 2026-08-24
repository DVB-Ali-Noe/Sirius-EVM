/**
 * Montants EVM en wei. Miroir de `src/lib/xrpl/amount.ts` (drops XRP).
 *
 * Les montants restent des **chaînes** de bout en bout — base, API, reçus HMAC
 * du runner — parce qu'un wei ne tient pas dans un `number` JavaScript :
 * 1 ETH = 10^18 wei, très au-delà de `Number.MAX_SAFE_INTEGER` (~9,007×10^15).
 * Toute arithmétique passe par `BigInt`.
 */

const WEI_PER_ETH = BigInt("1000000000000000000");
const ETH_DECIMALS = 18;

/** Plancher : en dessous, le prix ne couvre plus le coût du règlement on-chain. */
export const MIN_PRICE_WEI = BigInt("1000000000000"); // 0,000001 ETH
/** Plafond : garde-fou anti-faute de frappe côté provider. */
export const MAX_PRICE_WEI = BigInt("1000000000000000000000"); // 1 000 ETH

// Partie entière ≤ 4 chiffres (plafond 1 000) et jusqu'à 18 décimales.
const PRICE_PATTERN = /^(0|[1-9][0-9]{0,3})(?:\.([0-9]{1,18}))?$/;

/**
 * Convertit un prix saisi en ETH (« 0.25 ») vers des wei en chaîne décimale.
 * Renvoie `null` si la saisie est malformée ou hors bornes — jamais d'exception,
 * pour que l'appelant réponde 400 avec son propre message.
 */
export function priceEthToWei(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = PRICE_PATTERN.exec(value.trim());
  if (!match) return null;

  // On complète la fraction à 18 chiffres : « 0.25 » → « 250000000000000000 ».
  const fraction = (match[2] ?? "").padEnd(ETH_DECIMALS, "0");
  const wei = BigInt(match[1]) * WEI_PER_ETH + BigInt(fraction || "0");
  if (wei < MIN_PRICE_WEI || wei > MAX_PRICE_WEI) return null;
  return wei.toString();
}

/** Valide une chaîne de wei déjà persistée (reçu runner, corps de requête runner). */
export function isValidWeiAmount(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]{1,26}$/.test(value)) return false;
  const wei = BigInt(value);
  return wei >= MIN_PRICE_WEI && wei <= MAX_PRICE_WEI;
}

/** Formate des wei pour l'affichage, sans zéros de fin superflus. */
export function formatWeiAsEth(value: string): string {
  const wei = BigInt(value);
  const whole = wei / WEI_PER_ETH;
  const fraction = (wei % WEI_PER_ETH).toString().padStart(ETH_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
