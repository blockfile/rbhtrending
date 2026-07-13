import { describe, it, expect, beforeEach } from 'vitest';
import { trends, Tracker, type FollowEvent } from '../src/pipeline/trending';
import type { PoolActivity, TrendingConfig, FollowUpConfig } from '../src/types';

const TRENDING_CFG: TrendingConfig = {
  minLiquidityUsd: 5000,
  minVolume1hUsd: 10000,
  minBuyers1h: 30,
  pollSeconds: 45,
  milestones: [2, 5, 10],
  dumpDrawdownPct: 50,
};

const FOLLOWUP_CFG: FollowUpConfig = {
  windowMinutes: 60,
  liveEditSec: 45,
};

const activity = (overrides: Partial<PoolActivity> = {}): PoolActivity => ({
  address: 'addr1',
  symbol: 'COOL',
  name: 'Cool Token',
  liquidityUsd: 5000,
  volume1hUsd: 10000,
  buyers1h: 30,
  priceUsd: 1,
  fdvUsd: 100,
  poolAddress: 'pool1',
  createdAt: 0,
  ...overrides,
});

describe('trends', () => {
  it('returns false when liquidity is below the minimum, even with strong volume/buyers', () => {
    const a = activity({ liquidityUsd: 4999, volume1hUsd: 999999, buyers1h: 999 });
    expect(trends(a, TRENDING_CFG)).toBe(false);
  });

  it('returns true when liquidity is ok and volume1h meets the minimum', () => {
    const a = activity({ liquidityUsd: 5000, volume1hUsd: 10000, buyers1h: 0 });
    expect(trends(a, TRENDING_CFG)).toBe(true);
  });

  it('returns true when liquidity is ok and buyers1h meets the minimum', () => {
    const a = activity({ liquidityUsd: 5000, volume1hUsd: 0, buyers1h: 30 });
    expect(trends(a, TRENDING_CFG)).toBe(true);
  });

  it('returns false when liquidity is ok but neither volume nor buyers meet the minimum', () => {
    const a = activity({ liquidityUsd: 5000, volume1hUsd: 9999, buyers1h: 29 });
    expect(trends(a, TRENDING_CFG)).toBe(false);
  });

  it('returns true right at the liquidity boundary with volume also right at boundary', () => {
    const a = activity({ liquidityUsd: 5000, volume1hUsd: 10000, buyers1h: 0 });
    expect(trends(a, TRENDING_CFG)).toBe(true);
  });
});

describe('Tracker', () => {
  let tracker: Tracker;
  beforeEach(() => {
    tracker = new Tracker(TRENDING_CFG, FOLLOWUP_CFG);
  });

  describe('dedupe', () => {
    it('allows posting a fresh address', () => {
      expect(tracker.shouldPost('addr1')).toBe(true);
    });

    it('forbids re-posting after markPosted', () => {
      tracker.markPosted('addr1', 100, 0);
      expect(tracker.shouldPost('addr1')).toBe(false);
    });

    it('keeps other addresses postable', () => {
      tracker.markPosted('addr1', 100, 0);
      expect(tracker.shouldPost('addr2')).toBe(true);
    });

    it('is idempotent — a second markPosted for the same address does not reset tracked state', () => {
      tracker.markPosted('addr1', 100, 0);
      tracker.onUpdate('addr1', 200, 1000); // 2X fires, primes firedMilestones
      tracker.markPosted('addr1', 999, 2000); // caller mistake: re-post without checking shouldPost
      expect(tracker.get('addr1')?.baselineMcUsd).toBe(100);
      const events = tracker.onUpdate('addr1', 220, 3000); // still ~2.2X — should not re-fire 2X
      expect(events).toEqual([]);
    });
  });

  describe('onUpdate', () => {
    it('tracks peak/last without firing early', () => {
      tracker.markPosted('addr1', 100, 0);
      let events = tracker.onUpdate('addr1', 150, 1000); // 1.5X — below first milestone
      expect(events).toEqual([]);
      events = tracker.onUpdate('addr1', 120, 2000);
      expect(events).toEqual([]);
      expect(tracker.has('addr1')).toBe(true);
    });

    it('fires each up-Nx milestone once as the peak crosses it, and keeps tracking', () => {
      tracker.markPosted('addr1', 100, 0);
      let events = tracker.onUpdate('addr1', 200, 1000); // 2X
      expect(events).toEqual([{ kind: 'up', multiple: 2 }]);
      expect(tracker.has('addr1')).toBe(true);

      events = tracker.onUpdate('addr1', 260, 1500); // 2.6X — no new milestone
      expect(events).toEqual([]);

      events = tracker.onUpdate('addr1', 500, 2000); // 5X
      expect(events).toEqual([{ kind: 'up', multiple: 5 }]);
    });

    it('fires every milestone crossed by a single big jump, once each', () => {
      tracker.markPosted('addr1', 100, 0);
      const events = tracker.onUpdate('addr1', 1200, 1000); // 12X in one update
      expect(events).toEqual([
        { kind: 'up', multiple: 2 },
        { kind: 'up', multiple: 5 },
        { kind: 'up', multiple: 10 },
      ]);
    });

    it('does not double-fire a milestone once already crossed', () => {
      tracker.markPosted('addr1', 100, 0);
      tracker.onUpdate('addr1', 200, 1000); // 2X fires
      const events = tracker.onUpdate('addr1', 210, 1500); // still ~2.1X — no re-fire
      expect(events).toEqual([]);
    });

    it('fires a dump event when it falls >dumpDrawdownPct off peak, and removes it from tracking', () => {
      tracker.markPosted('addr1', 100, 0);
      tracker.onUpdate('addr1', 200, 1000); // peak 200 (also 2X — up event)
      const events = tracker.onUpdate('addr1', 90, 2000); // -55% off peak
      expect(events.map((e) => e.kind)).toEqual(['dump']);
      expect(tracker.has('addr1')).toBe(false);
    });

    it('stops firing once removed by a dump', () => {
      tracker.markPosted('addr1', 100, 0);
      tracker.onUpdate('addr1', 200, 1000);
      tracker.onUpdate('addr1', 90, 2000); // dump, removed
      const events = tracker.onUpdate('addr1', 80, 3000); // no longer tracked
      expect(events).toEqual([]);
    });

    it('ignores a non-positive market-cap update (no spurious dump)', () => {
      tracker.markPosted('addr1', 100, 0);
      const events = tracker.onUpdate('addr1', 0, 1000);
      expect(events).toEqual([]);
      expect(tracker.has('addr1')).toBe(true);
    });

    it('returns no events for an address that was never posted', () => {
      const events = tracker.onUpdate('addr-unknown', 500, 1000);
      expect(events).toEqual([]);
    });
  });

  describe('sweep (expiry)', () => {
    it('removes a token and reports a window expiry after windowMinutes elapses', () => {
      tracker.markPosted('addr1', 100, 0);
      tracker.onUpdate('addr1', 130, 1000);
      const expired = tracker.sweep(60 * 60_000 + 1);
      expect(expired).toEqual([{ address: 'addr1', event: { kind: 'window' } }]);
      expect(tracker.has('addr1')).toBe(false);
    });

    it('does not expire before the window elapses', () => {
      tracker.markPosted('addr1', 100, 0);
      const expired = tracker.sweep(60 * 60_000 - 1);
      expect(expired).toEqual([]);
      expect(tracker.has('addr1')).toBe(true);
    });

    it('leaves dedupe intact after a window expiry (still not re-postable)', () => {
      tracker.markPosted('addr1', 100, 0);
      tracker.sweep(60 * 60_000 + 1);
      expect(tracker.shouldPost('addr1')).toBe(false);
    });
  });
});
