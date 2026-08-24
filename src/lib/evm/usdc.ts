const ATOMIC_PER_USDC = BigInt("1000000");
const USDC_DECIMALS = 6;

export const MIN_PRICE_USDC_ATOMIC = BigInt("1000");
export const MAX_PRICE_USDC_ATOMIC = BigInt("1000000000000");

const PRICE_PATTERN = /^(0|[1-9][0-9]{0,6})(?:\.([0-9]{1,6}))?$/;

export function priceUsdcToAtomic(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = PRICE_PATTERN.exec(value.trim());
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(USDC_DECIMALS, "0");
  const amount = BigInt(match[1]) * ATOMIC_PER_USDC + BigInt(fraction || "0");
  if (amount < MIN_PRICE_USDC_ATOMIC || amount > MAX_PRICE_USDC_ATOMIC) return null;
  return amount.toString();
}

export function isValidUsdcAtomicAmount(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]{1,26}$/.test(value)) return false;
  const amount = BigInt(value);
  return amount >= MIN_PRICE_USDC_ATOMIC && amount <= MAX_PRICE_USDC_ATOMIC;
}

export function formatUsdcAtomic(value: string): string {
  const amount = BigInt(value);
  const whole = amount / ATOMIC_PER_USDC;
  const fraction = (amount % ATOMIC_PER_USDC).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
