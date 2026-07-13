import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runCycle, type RunCycleDeps, type GeckoLike, type TelegramLike } from '../src/pipeline/runCycle';
import { Db } from '../src/db/index';
import { Tracker } from '../src/pipeline/trending';
import type {
  AppConfig,
  ButtonsConfig,
  FollowUpConfig,
  PoolActivity,
  Security,
  SecurityConfig,
  TokenCard,
  TrendingConfig,
} from '../src/types';

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

const SAFE_SECURITY: Security = { sellTaxPct: 'unknown', topHolderPct: 'unknown', riskLevel: 'safe' };

function pool(overrides: Partial<PoolActivity> = {}): PoolActivity {
  return {
    address: '0xAAA',
    symbol: 'COOL',
    name: 'Cool Token',
    liquidityUsd: 5000,
    volume1hUsd: 10000,
    buyers1h: 30,
    priceUsd: 1,
    fdvUsd: 100000,
    poolAddress: '0xPOOL',
    createdAt: 0,
    ...overrides,
  };
}

async function fakeEnrich(activity: PoolActivity): Promise<TokenCard> {
  return {
    address: activity.address,
    symbol: activity.symbol,
    name: activity.name,
    liquidityUsd: activity.liquidityUsd,
    volume1hUsd: activity.volume1hUsd,
    buyers1h: activity.buyers1h,
    priceUsd: activity.priceUsd,
    fdvUsd: activity.fdvUsd,
    poolAddress: activity.poolAddress,
    createdAt: activity.createdAt,
    security: SAFE_SECURITY,
  };
}

function gecko(trending: PoolActivity[], fresh: PoolActivity[] = []): GeckoLike {
  return {
    trendingPools: async () => trending,
    newPools: async () => fresh,
  };
}

/** Reads the `tokens` table directly (Db exposes no "was this seen" getter) to confirm recordSeen ran. */
function wasSeen(db: Db, address: string): boolean {
  const raw = (db as unknown as { db: Database.Database }).db;
  return !!raw.prepare('SELECT 1 FROM tokens WHERE address = ?').get(address);
}

describe('runCycle', () => {
  let db: Db;
  let tracker: Tracker;
  let sends: Array<{ text: string; buttons?: unknown }>;
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
      gecko: gecko([]),
      db,
      tracker,
      telegram,
      securityScan: async () => 'unknown',
      enrich: fakeEnrich,
      cfg: CFG,
      dry: false,
      ...overrides,
    };
  }

  it('posts only the trending, not-yet-posted pool and records it as posted', async () => {
    const trending = pool({ address: '0xTREND', liquidityUsd: 6000, volume1hUsd: 20000, buyers1h: 50 });
    const flat = pool({ address: '0xFLAT', liquidityUsd: 100, volume1hUsd: 0, buyers1h: 0 });
    const deps = baseDeps({ gecko: gecko([trending, flat]) });

    await runCycle(deps, 1000);

    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain('COOL');
    expect(db.alreadyPosted('0xTREND')).toBe(true);
    expect(db.alreadyPosted('0xFLAT')).toBe(false);
    expect(wasSeen(db, '0xTREND')).toBe(true);
    expect(wasSeen(db, '0xFLAT')).toBe(true);
  });

  it('does not re-post a pool already posted in an earlier cycle', async () => {
    const trending = pool({ address: '0xTREND', liquidityUsd: 6000, volume1hUsd: 20000, buyers1h: 50 });
    const deps = baseDeps({ gecko: gecko([trending]) });

    await runCycle(deps, 1000);
    expect(sends).toHaveLength(1);

    await runCycle(deps, 2000);
    expect(sends).toHaveLength(1);
  });

  it('deduplicates pools seen in both trendingPools and newPools by address (first wins)', async () => {
    const trending = pool({ address: '0xTREND', liquidityUsd: 6000, volume1hUsd: 20000, buyers1h: 50, symbol: 'FIRST' });
    const dup = pool({ address: '0xTREND', liquidityUsd: 6000, volume1hUsd: 20000, buyers1h: 50, symbol: 'SECOND' });
    const deps = baseDeps({ gecko: gecko([trending], [dup]) });

    await runCycle(deps, 1000);

    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain('FIRST');
  });

  it('produces an "up" follow-up send when a tracked pool doubles its fdv', async () => {
    const trending = pool({ address: '0xTREND', liquidityUsd: 6000, volume1hUsd: 20000, buyers1h: 50, fdvUsd: 100000 });
    const deps1 = baseDeps({ gecko: gecko([trending]) });
    await runCycle(deps1, 1000);
    expect(sends).toHaveLength(1);

    const doubled = pool({ address: '0xTREND', fdvUsd: 200000 });
    const deps2 = baseDeps({ gecko: gecko([doubled]) });
    await runCycle(deps2, 2000);

    expect(sends).toHaveLength(2);
    expect(sends[1].text).toContain('2X');
  });

  it('does not post a pool that fails the trending gate', async () => {
    const flat = pool({ address: '0xFLAT', liquidityUsd: 100, volume1hUsd: 0, buyers1h: 0 });
    const deps = baseDeps({ gecko: gecko([flat]) });

    await runCycle(deps, 1000);

    expect(sends).toHaveLength(0);
    expect(db.alreadyPosted('0xFLAT')).toBe(false);
  });

  it('--dry mode sends nothing to telegram but still records seen and marks the token tracked', async () => {
    const trending = pool({ address: '0xTREND', liquidityUsd: 6000, volume1hUsd: 20000, buyers1h: 50 });
    const deps = baseDeps({ gecko: gecko([trending]), dry: true });

    await runCycle(deps, 1000);

    expect(sends).toHaveLength(0);
    expect(wasSeen(db, '0xTREND')).toBe(true);
    expect(tracker.shouldPost('0xTREND')).toBe(false);
    expect(tracker.has('0xTREND')).toBe(true);
  });

  it('a bad gecko fetch (trendingPools throws) degrades to empty rather than killing the cycle', async () => {
    const badGecko: GeckoLike = {
      trendingPools: async () => {
        throw new Error('network down');
      },
      newPools: async () => [pool({ address: '0xOK', liquidityUsd: 6000, volume1hUsd: 20000, buyers1h: 50 })],
    };
    const deps = baseDeps({ gecko: badGecko });

    await expect(runCycle(deps, 1000)).resolves.not.toThrow();
    expect(sends).toHaveLength(1);
    expect(db.alreadyPosted('0xOK')).toBe(true);
  });

  it('one pool throwing mid-cycle does not stop other pools from being processed', async () => {
    const bad = pool({ address: '0xBAD', liquidityUsd: 6000, volume1hUsd: 20000, buyers1h: 50, symbol: 'BAD' });
    const good = pool({ address: '0xGOOD', liquidityUsd: 6000, volume1hUsd: 20000, buyers1h: 50, symbol: 'GOOD' });
    const deps = baseDeps({
      gecko: gecko([bad, good]),
      enrich: async (activity) => {
        if (activity.address === '0xBAD') throw new Error('enrich exploded');
        return fakeEnrich(activity);
      },
    });

    await expect(runCycle(deps, 1000)).resolves.not.toThrow();

    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain('GOOD');
    expect(db.alreadyPosted('0xBAD')).toBe(false);
    expect(db.alreadyPosted('0xGOOD')).toBe(true);
  });
});
