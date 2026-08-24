const DROPS_PER_XRP = BigInt(1_000_000);
const MIN_PRICE_DROPS = BigInt(1_000);
const MAX_PRICE_DROPS = BigInt(1_000_000_000_000);

export function priceXrpToDrops(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const match = /^(0|[1-9][0-9]{0,6})(?:\.([0-9]{1,6}))?$/.exec(text);
  if (!match) return null;

  const fraction = (match[2] ?? "").padEnd(6, "0");
  const drops = BigInt(match[1]) * DROPS_PER_XRP + BigInt(fraction || "0");
  if (drops < MIN_PRICE_DROPS || drops > MAX_PRICE_DROPS) return null;
  return drops.toString();
}
