import type { GmgnToken, TrendingConfig, FollowUpConfig } from '../types';

/**
 * Dead-bounce check: an old token sitting far below its ATH is a rug corpse whose burst of
 * bot/bounce buys can still satisfy the activity gate (GMGN's rank list is activity-based and
 * happily re-lists them). Applies only from `minMcOfAthAgeHours` of age — young tokens
 * retracing off their launch spike are normal — and only when both age and ATH are known.
 */
function isDeadBounce(t: GmgnToken, cfg: TrendingConfig, now: number): boolean {
  if (!t.createdAt || !(t.athMarketCapUsd > 0)) return false;
  const ageHours = (now - t.createdAt) / 3_600_000;
  if (ageHours < cfg.minMcOfAthAgeHours) return false;
  return t.marketCapUsd < t.athMarketCapUsd * (cfg.minMcOfAthPct / 100);
}

/**
 * Pure trending gate: does this token's current activity clear the configured thresholds?
 * Confirmed honeypots and dead bounces are hard-filtered here — they never post, get seeded,
 * or tracked. Liquidity must always clear the floor; either volume or buyer count clearing its
 * own floor is enough on top of that. GMGN-native (Task G3) — reads a `GmgnToken`'s
 * `volumeUsd`/`buys`.
 */
export function passesGate(t: GmgnToken, cfg: TrendingConfig, now: number): boolean {
  return (
    !t.honeypot &&
    t.liquidityUsd >= cfg.minLiquidityUsd &&
    (t.volumeUsd >= cfg.minVolume1hUsd || t.buys >= cfg.minBuyers1h) &&
    !isDeadBounce(t, cfg, now)
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
