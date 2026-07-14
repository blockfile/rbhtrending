import type { PromoConfig, PromoTierConfig, PromoTierKey } from '../types';

export const TIER_ORDER: PromoTierKey[] = ['top3', 'top8', 'top12'];

/** Leaderboard rank range a tier occupies — each tier starts right below the previous one's
 * maxRank (top3 → 1..3, top8 → 4..8, top12 → 9..12). */
export function tierRange(tiers: Record<PromoTierKey, PromoTierConfig>, key: PromoTierKey): { from: number; to: number } {
  const idx = TIER_ORDER.indexOf(key);
  const from = idx === 0 ? 1 : tiers[TIER_ORDER[idx - 1]].maxRank + 1;
  return { from, to: tiers[key].maxRank };
}

/**
 * The tier price as an exact wei amount. Each order gets its own deposit address, so the amount
 * itself no longer needs to be unique — the buyer pays the clean price. Precision is micro-ETH
 * so config values like 0.18 convert exactly (0.18 → 180000000000000000 wei).
 */
export function priceToWei(priceEth: number): string {
  return (BigInt(Math.round(priceEth * 1e6)) * 1_000_000_000_000n).toString();
}

/** Render a wei decimal-string as a trimmed ETH amount ("100000001000000000" → "0.100000001"). */
export function formatEth(wei: string): string {
  const v = BigInt(wei);
  const int = v / 1_000_000_000_000_000_000n;
  const frac = (v % 1_000_000_000_000_000_000n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int.toString();
}

/** Lowest free leaderboard rank inside the tier's range, or null when the range is full. */
export function assignRank(
  tiers: Record<PromoTierKey, PromoTierConfig>,
  key: PromoTierKey,
  usedRanks: number[],
): number | null {
  const { from, to } = tierRange(tiers, key);
  for (let r = from; r <= to; r++) {
    if (!usedRanks.includes(r)) return r;
  }
  return null;
}

/** Remaining sellable inventory for a tier given its open (pending + active) order count. */
export function slotsLeft(cfg: PromoConfig, key: PromoTierKey, openCount: number): number {
  return Math.max(0, cfg.tiers[key].slots - openCount);
}
