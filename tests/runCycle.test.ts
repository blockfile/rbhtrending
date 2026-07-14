import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runCycle, type RunCycleDeps, type GmgnLike, type TelegramLike } from '../src/pipeline/runCycle';
import { Db } from '../src/db/index';
import { Tracker } from '../src/pipeline/trending';
import type { AppConfig, ButtonsConfig, FollowUpConfig, GmgnToken, TrendingConfig } from '../src/types';

const TRENDING_CFG: TrendingConfig = {
  minLiquidityUsd: 5000,
  minVolume1hUsd: 10000,
  minBuyers1h: 30,
  pollSeconds: 45,
  milestones: [2, 5, 10],
  dumpDrawdownPct: 50,
  maxPostsPerCycle: 10,
  minMcOfAthPct: 20,
  minMcOfAthAgeHours: 24,
};
const FOLLOWUP_CFG: FollowUpConfig = { windowMinutes: 120, liveEditSec: 45 };
const BUTTONS_CFG: ButtonsConfig = { chart: true, scan: true, trade: true };
const CFG: AppConfig = { trending: TRENDING_CFG, followUp: FOLLOWUP_CFG, buttons: BUTTONS_CFG };

function token(overrides: Partial<GmgnToken> = {}): GmgnToken {
  return {
    address: '0xAAA',
    name: 'Cool Token',
    symbol: 'COOL',
    logo: 'https://example.com/logo.png',
    priceUsd: 1,
    priceChange1hPct: 0,
    volumeUsd: 20000,
    liquidityUsd: 6000,
    marketCapUsd: 100000,
    athMarketCapUsd: 100000,
    swaps: 100,
    buys: 50,
    sells: 40,
    holderCount: 200,
    top10Pct: 10,
    createdAt: 0,
    twitter: undefined,
    telegram: undefined,
    website: undefined,
    honeypot: false,
    buyTaxPct: 0,
    sellTaxPct: 0,
    renounced: true,
    verified: true,
    lpLockedPct: 100,
    devHoldPct: 0,
    rugRatioPct: 0,
    burnPct: 0,
    smartMoneyCount: 0,
    kolCount: 0,
    sniperCount: 0,
    bundlerRatePct: 0,
    entrapmentPct: 0,
    ratTraderPct: 0,
    botDegenPct: 0,
    washTrading: false,
    hotLevel: 0,
    ...overrides,
  };
}

/** Reads the `tokens` table directly (Db exposes no "was this seen" getter) to confirm recordSeen ran. */
function wasSeen(db: Db, address: string): boolean {
  const raw = (db as unknown as { db: Database.Database }).db;
  return !!raw.prepare('SELECT 1 FROM tokens WHERE address = ?').get(address);
}

function gmgn(tokens: GmgnToken[]): GmgnLike {
  return { trending: async () => tokens };
}

describe('runCycle', () => {
  let db: Db;
  let tracker: Tracker;
  let sends: Array<{ text: string; photoUrl?: string; buttons?: unknown }>;
  let telegram: TelegramLike;

  beforeEach(() => {
    db = new Db(':memory:');
    tracker = new Tracker(TRENDING_CFG, FOLLOWUP_CFG);
    sends = [];
    telegram = {
      send: async (p) => {
        const payload = typeof p === 'string' ? { text: p } : p;
        sends.push(payload);
        return { ok: true, messageId: sends.length };
      },
    };
  });

  afterEach(() => {
    db.close();
  });

  function baseDeps(overrides: Partial<RunCycleDeps> = {}): RunCycleDeps {
    return {
      gmgn: gmgn([]),
      db,
      tracker,
      telegram,
      cfg: CFG,
      dry: false,
      ...overrides,
    };
  }

  /** Bumps db.postCount() above 0 so a cycle is not treated as the first-ever ("cold start")
   * run (Task G4) — used by tests that exercise ordinary post/dedupe/follow-up behavior rather
   * than cold-start seeding itself. */
  function seedNonColdStart(): void {
    db.recordPost('0xSEED-DUMMY', 0, 0);
  }

  it('posts only the gate-passing, not-yet-posted token, with photoUrl = weserv-proxied logo (gmgn.ai is Cloudflare-blocked for Telegram), and records it as posted', async () => {
    seedNonColdStart();
    const trending = token({ address: '0xTREND', liquidityUsd: 6000, volumeUsd: 20000, buys: 50, logo: 'https://x/logo.png' });
    const flat = token({ address: '0xFLAT', liquidityUsd: 100, volumeUsd: 0, buys: 0 });
    const deps = baseDeps({ gmgn: gmgn([trending, flat]) });

    await runCycle(deps, 1000);

    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain('COOL');
    expect(sends[0].photoUrl).toBe('https://images.weserv.nl/?url=https%3A%2F%2Fx%2Flogo.png');
    expect(db.alreadyPosted('0xTREND')).toBe(true);
    expect(db.alreadyPosted('0xFLAT')).toBe(false);
    expect(wasSeen(db, '0xTREND')).toBe(true);
    expect(wasSeen(db, '0xFLAT')).toBe(true);
  });

  it('does not re-post a token already posted in an earlier cycle', async () => {
    seedNonColdStart();
    const trending = token({ address: '0xTREND' });
    const deps = baseDeps({ gmgn: gmgn([trending]) });

    await runCycle(deps, 1000);
    expect(sends).toHaveLength(1);

    await runCycle(deps, 2000);
    expect(sends).toHaveLength(1);
  });

  it('does not post a token that fails the trending gate', async () => {
    const flat = token({ address: '0xFLAT', liquidityUsd: 100, volumeUsd: 0, buys: 0 });
    const deps = baseDeps({ gmgn: gmgn([flat]) });

    await runCycle(deps, 1000);

    expect(sends).toHaveLength(0);
    expect(db.alreadyPosted('0xFLAT')).toBe(false);
  });

  it('produces an "up" follow-up send when a tracked token doubles its market cap', async () => {
    seedNonColdStart();
    const trending = token({ address: '0xTREND', marketCapUsd: 100000 });
    const deps1 = baseDeps({ gmgn: gmgn([trending]) });
    await runCycle(deps1, 1000);
    expect(sends).toHaveLength(1);

    const doubled = token({ address: '0xTREND', marketCapUsd: 200000 });
    const deps2 = baseDeps({ gmgn: gmgn([doubled]) });
    await runCycle(deps2, 2000);

    expect(sends).toHaveLength(2);
    expect(sends[1].text).toContain('2X');
    // follow-ups carry the same token image as the original alert card
    expect(sends[1].photoUrl).toBe('https://images.weserv.nl/?url=https%3A%2F%2Fexample.com%2Flogo.png');
  });

  it('produces a "dump" follow-up send when a tracked token falls hard off its peak', async () => {
    seedNonColdStart();
    const trending = token({ address: '0xTREND', marketCapUsd: 100000 });
    const deps1 = baseDeps({ gmgn: gmgn([trending]) });
    await runCycle(deps1, 1000);
    expect(sends).toHaveLength(1);

    const peaked = token({ address: '0xTREND', marketCapUsd: 200000 });
    await runCycle(baseDeps({ gmgn: gmgn([peaked]) }), 2000);
    expect(sends).toHaveLength(2); // 2X up follow-up

    const dumped = token({ address: '0xTREND', marketCapUsd: 80000 }); // -60% off 200000 peak
    await runCycle(baseDeps({ gmgn: gmgn([dumped]) }), 3000);
    expect(sends).toHaveLength(3);
    expect(sends[2].text.toLowerCase()).toContain('dump');
    expect(sends[2].photoUrl).toBe('https://images.weserv.nl/?url=https%3A%2F%2Fexample.com%2Flogo.png');
  });

  it('--dry mode sends nothing to telegram but still records seen and marks the token tracked', async () => {
    seedNonColdStart();
    const trending = token({ address: '0xTREND' });
    const deps = baseDeps({ gmgn: gmgn([trending]), dry: true });

    await runCycle(deps, 1000);

    expect(sends).toHaveLength(0);
    expect(wasSeen(db, '0xTREND')).toBe(true);
    expect(tracker.shouldPost('0xTREND')).toBe(false);
    expect(tracker.has('0xTREND')).toBe(true);
    expect(db.alreadyPosted('0xTREND')).toBe(false); // dry never records a post
  });

  it('--dry mode sends nothing for follow-ups either', async () => {
    seedNonColdStart();
    const trending = token({ address: '0xTREND', marketCapUsd: 100000 });
    await runCycle(baseDeps({ gmgn: gmgn([trending]) }), 1000);
    expect(sends).toHaveLength(1);

    const doubled = token({ address: '0xTREND', marketCapUsd: 200000 });
    await runCycle(baseDeps({ gmgn: gmgn([doubled]), dry: true }), 2000);

    expect(sends).toHaveLength(1); // no new send in dry mode
  });

  it('a bad gmgn fetch (trending throws) degrades to empty rather than killing the cycle', async () => {
    const badGmgn: GmgnLike = {
      trending: async () => {
        throw new Error('network down');
      },
    };
    const deps = baseDeps({ gmgn: badGmgn });

    await expect(runCycle(deps, 1000)).resolves.not.toThrow();
    expect(sends).toHaveLength(0);
  });

  describe('cold-start silent seed (Task G4)', () => {
    it('on the first-ever run, seeds gate-passing tokens as already-posted without sending, and does not track them for follow-ups', async () => {
      const a = token({ address: '0xA', symbol: 'AAA' });
      const b = token({ address: '0xB', symbol: 'BBB' });
      const deps = baseDeps({ gmgn: gmgn([a, b]) });

      await runCycle(deps, 1000);

      expect(sends).toHaveLength(0);
      expect(db.alreadyPosted('0xA')).toBe(true);
      expect(db.alreadyPosted('0xB')).toBe(true);
      expect(tracker.has('0xA')).toBe(false);
      expect(tracker.has('0xB')).toBe(false);
    });

    it('alerts a brand-new entrant on a later cycle once seeding has happened (no longer cold start)', async () => {
      const a = token({ address: '0xA', symbol: 'AAA' });
      const b = token({ address: '0xB', symbol: 'BBB' });
      await runCycle(baseDeps({ gmgn: gmgn([a, b]) }), 1000);
      expect(sends).toHaveLength(0);

      const c = token({ address: '0xC', symbol: 'CCC' });
      await runCycle(baseDeps({ gmgn: gmgn([a, b, c]) }), 2000);

      expect(sends).toHaveLength(1);
      expect(sends[0].text).toContain('CCC');
      expect(db.alreadyPosted('0xC')).toBe(true);
      // the previously-seeded tokens are still skipped (already marked posted)
      expect(db.alreadyPosted('0xA')).toBe(true);
      expect(db.alreadyPosted('0xB')).toBe(true);
    });

    it('logs a one-line seed summary', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const a = token({ address: '0xA' });
        const b = token({ address: '0xB' });
        await runCycle(baseDeps({ gmgn: gmgn([a, b]) }), 1000);

        const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(logged).toContain('cold start: seeded 2 trending tokens (no alerts sent)');
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('in --dry mode, sends nothing and does not persist the seed, but logs a "would seed" summary', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const a = token({ address: '0xA' });
        const deps = baseDeps({ gmgn: gmgn([a]), dry: true });

        await runCycle(deps, 1000);

        expect(sends).toHaveLength(0);
        expect(db.alreadyPosted('0xA')).toBe(false); // dry never records a post, even a seeded one
        const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(logged).toContain('would seed');
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  describe('per-cycle post cap (Task G4)', () => {
    it('sends at most maxPostsPerCycle new posts in a single cycle, deferring the rest', async () => {
      seedNonColdStart();
      const cappedCfg: AppConfig = { ...CFG, trending: { ...TRENDING_CFG, maxPostsPerCycle: 2 } };
      const fresh = [0, 1, 2, 3, 4].map((i) => token({ address: `0xT${i}`, symbol: `T${i}` }));
      const deps = baseDeps({ gmgn: gmgn(fresh), cfg: cappedCfg });

      await runCycle(deps, 1000);

      expect(sends).toHaveLength(2);
      const postedAfterFirstCycle = fresh.filter((t) => db.alreadyPosted(t.address)).length;
      expect(postedAfterFirstCycle).toBe(2);
    });

    it('sends the deferred remainder on a following cycle', async () => {
      seedNonColdStart();
      const cappedCfg: AppConfig = { ...CFG, trending: { ...TRENDING_CFG, maxPostsPerCycle: 2 } };
      const fresh = [0, 1, 2, 3, 4].map((i) => token({ address: `0xT${i}`, symbol: `T${i}` }));

      await runCycle(baseDeps({ gmgn: gmgn(fresh), cfg: cappedCfg }), 1000);
      expect(sends).toHaveLength(2);

      await runCycle(baseDeps({ gmgn: gmgn(fresh), cfg: cappedCfg }), 2000);

      expect(sends).toHaveLength(4);
      const postedAfterSecondCycle = fresh.filter((t) => db.alreadyPosted(t.address)).length;
      expect(postedAfterSecondCycle).toBe(4); // one token still remains for a later cycle
    });
  });
});
