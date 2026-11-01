/**
 * "1.5" with 6 decimals becomes "1500000". Returns null for anything that is not a plain positive
 * decimal that fits the asset's precision, so a typo can never be rounded into a different amount.
 */
export function toUnits(text: string, decimals: number): string | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  const units = BigInt(whole + frac.padEnd(decimals, "0"));
  return units > 0n ? units.toString() : null;
}
