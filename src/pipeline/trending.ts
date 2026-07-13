import type { GmgnToken, PoolActivity, TrendingConfig, FollowUpConfig } from '../types';

/**
 * Pure trending gate: does this pool's current activity clear the configured
 * thresholds? Liquidity must always clear the floor; either volume or buyer
 * count clearing its own floor is enough on top of that.
 *
 * Kept for the still-live GeckoTerminal-era code paths/tests (Task G3 leaves those modules in
 * place); `passesGate` below is the GMGN-native equivalent used by the current pipeline.
 */
export function trends(a: PoolActivity, cfg: TrendingConfig): boolean {
  return (
    a.liquidityUsd >= cfg.minLiquidityUsd &&
    (a.volume1hUsd >= cfg.minVolume1hUsd || a.buyers1h >= cfg.minBuyers1h)
  );
}

/**
 * GMGN-native trending gate (Task G3): same shape as `trends`, but reads a `GmgnToken`'s
 * `volumeUsd`/`buys` in place of `PoolActivity`'s `volume1hUsd`/`buyers1h`.
 */
export function passesGate(t: GmgnToken, cfg: TrendingConfig): boolean {
  return (
    t.liquidityUsd >= cfg.minLiquidityUsd &&
    (t.volumeUsd >= cfg.minVolume1hUsd || t.buys >= cfg.minBuyers1h)
  );
}

export interface TrackedToken {
  address: string;
  baselineMcUsd: number;
  peakMcUsd: number;
  lastMcUsd: number;
  postedAt: number;
  firedMilestones: number[];
}

export type FollowEvent =
  | { kind: 'up'; multiple: number }
  | { kind: 'dump' }
  | { kind: 'window' };

/**
 * Tracks tokens that have already been posted, watching polled market-cap
 * updates for milestone (up-Nx) crossings and dump drawdowns. Mirrors the
 * Solana FollowUps pipeline's dedupe/milestone/dump semantics, but is driven
 * by a poller calling onUpdate with fresh market-cap reads rather than a live
 * trade stream — so there's no per-token subscribe/unsubscribe hook here.
 */
export class Tracker {
  private posted = new Set<string>();
  private items = new Map<string, TrackedToken>();
  private milestones: number[];

  constructor(private trendingCfg: TrendingConfig, private followUpCfg: FollowUpConfig) {
    this.milestones = [...trendingCfg.milestones].sort((a, b) => a - b);
  }

  get size(): number { return this.items.size; }
  has(address: string): boolean { return this.items.has(address); }
  get(address: string): TrackedToken | undefined { return this.items.get(address); }

  /** A token address may be posted at most once, ever. */
  shouldPost(address: string): boolean {
    return !this.posted.has(address);
  }

  markPosted(address: string, baselineMcUsd: number, now: number): void {
    if (this.posted.has(address)) return; // idempotent — mirrors the Solana add() guard
    this.posted.add(address);
    this.items.set(address, {
      address,
      baselineMcUsd,
      peakMcUsd: baselineMcUsd,
      lastMcUsd: baselineMcUsd,
      postedAt: now,
      firedMilestones: [],
    });
  }

  /**
   * Feed a fresh polled market-cap read for a tracked token. Returns any
   * newly-crossed up-Nx milestone events, followed by a dump event if the
   * drawdown off peak exceeds the configured threshold (which also ends
   * tracking for that address). Addresses that were never posted, or whose
   * market-cap read is non-positive, produce no events.
   */
  onUpdate(address: string, currentMcUsd: number, _now: number): FollowEvent[] {
    const t = this.items.get(address);
    if (!t) return [];
    if (!(currentMcUsd > 0)) return [];

    t.lastMcUsd = currentMcUsd;
    if (currentMcUsd > t.peakMcUsd) t.peakMcUsd = currentMcUsd;

    const events: FollowEvent[] = [];

    // up-Nx milestones — each fires once, based on peak vs the market cap at post time
    const multiple = t.baselineMcUsd > 0 ? t.peakMcUsd / t.baselineMcUsd : 0;
    for (const m of this.milestones) {
      if (multiple >= m && !t.firedMilestones.includes(m)) {
        t.firedMilestones.push(m);
        events.push({ kind: 'up', multiple: m });
      }
    }

    // dump warning — a hard fall off the peak ends tracking
    const drawdown = t.peakMcUsd > 0 ? ((t.peakMcUsd - t.lastMcUsd) / t.peakMcUsd) * 100 : 0;
    if (drawdown > this.trendingCfg.dumpDrawdownPct) {
      this.items.delete(address);
      events.push({ kind: 'dump' });
    }

    return events;
  }

  /**
   * Bounded cleanup: drop any tokens whose post-time is older than
   * followUpConfig.windowMinutes, regardless of whether onUpdate is still
   * being called for them (a token can fall off the poller's trending/new
   * pool list before it dumps or moons). Returns the window-expiry events
   * for the addresses removed.
   */
  sweep(now: number): Array<{ address: string; event: FollowEvent }> {
    const cutoff = this.followUpCfg.windowMinutes * 60_000;
    const expired: Array<{ address: string; event: FollowEvent }> = [];
    for (const t of this.items.values()) {
      if (now - t.postedAt >= cutoff) {
        expired.push({ address: t.address, event: { kind: 'window' } });
      }
    }
    for (const { address } of expired) {
      this.items.delete(address);
    }
    return expired;
  }
}
