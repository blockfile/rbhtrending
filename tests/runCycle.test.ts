import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runCycle, type RunCycleDeps, type GmgnLike, type TelegramLike } from '../src/pipeline/runCycle';
import { Db } from '../src/db/index';
import { Tracker } from '../src/pipeline/trending';
import type { AppConfig, ButtonsConfig, FollowUpConfig, GmgnToken, SecurityConfig, TrendingConfig } from '../src/types';

const TRENDING_CFG: TrendingConfig = {
  minLiquidityUsd: 5000,
  minVolume1hUsd: 10000,
  minBuyers1h: 30,
  pollSeconds: 45,
  milestones: [2, 5, 10],
  dumpDrawdownPct: 50,
};
const SECURITY_CFG: SecurityConfig = { sellTaxDangerPct: 30, sellTaxWarnPct: 10, topHolderWarnPct: 25 };
const FOLLOWUP_CFG: FollowUpConfig = { windowMinutes: 120, liveEditSec: 45 };
const BUTTONS_CFG: ButtonsConfig = { chart: true, scan: true, trade: true };
const CFG: AppConfig = { trending: TRENDING_CFG, security: SECURITY_CFG, followUp: FOLLOWUP_CFG, buttons: BUTTONS_CFG };

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

  it('posts only the gate-passing, not-yet-posted token, with photoUrl = logo, and records it as posted', async () => {
    const trending = token({ address: '0xTREND', liquidityUsd: 6000, volumeUsd: 20000, buys: 50, logo: 'https://x/logo.png' });
    const flat = token({ address: '0xFLAT', liquidityUsd: 100, volumeUsd: 0, buys: 0 });
    const deps = baseDeps({ gmgn: gmgn([trending, flat]) });

    await runCycle(deps, 1000);

    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain('COOL');
    expect(sends[0].photoUrl).toBe('https://x/logo.png');
    expect(db.alreadyPosted('0xTREND')).toBe(true);
    expect(db.alreadyPosted('0xFLAT')).toBe(false);
    expect(wasSeen(db, '0xTREND')).toBe(true);
    expect(wasSeen(db, '0xFLAT')).toBe(true);
  });

  it('does not re-post a token already posted in an earlier cycle', async () => {
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
    const trending = token({ address: '0xTREND', marketCapUsd: 100000 });
    const deps1 = baseDeps({ gmgn: gmgn([trending]) });
    await runCycle(deps1, 1000);
    expect(sends).toHaveLength(1);

    const doubled = token({ address: '0xTREND', marketCapUsd: 200000 });
    const deps2 = baseDeps({ gmgn: gmgn([doubled]) });
    await runCycle(deps2, 2000);

    expect(sends).toHaveLength(2);
    expect(sends[1].text).toContain('2X');
  });

  it('produces a "dump" follow-up send when a tracked token falls hard off its peak', async () => {
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
  });

  it('--dry mode sends nothing to telegram but still records seen and marks the token tracked', async () => {
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
});
