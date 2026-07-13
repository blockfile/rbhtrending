import { describe, it, expect } from 'vitest';
import { enrich, type EnrichDeps } from '../src/pipeline/enrich';
import type { PoolActivity, Security, SecurityConfig } from '../src/types';

const activity = (overrides: Partial<PoolActivity> = {}): PoolActivity => ({
  address: '0xTOKEN',
  symbol: 'COOL',
  name: 'Cool Token',
  liquidityUsd: 5000,
  volume1hUsd: 10000,
  buyers1h: 30,
  priceUsd: 1.5,
  fdvUsd: 100000,
  poolAddress: '0xPOOL',
  createdAt: 123,
  ...overrides,
});

const SECURITY_CFG: SecurityConfig = { sellTaxDangerPct: 30, sellTaxWarnPct: 10, topHolderWarnPct: 25 };

const SAFE_SECURITY: Security = {
  sellTaxPct: 0,
  topHolderPct: 5,
  riskLevel: 'safe',
};

// A fully-populated Security, shaped like a real securityScan() result (every sub-check
// explicitly known-good), used for the concentration-folding tests below — a minimal fixture
// like SAFE_SECURITY would recompute to 'warn' regardless of topHolderPct purely because its
// unset optional sub-checks default to 'unknown', which isn't what those tests are isolating.
const CLEAN_SECURITY: Security = {
  sellTaxPct: 'unknown',
  topHolderPct: 'unknown',
  riskLevel: 'safe',
  honeypot: 'unknown',
  buyTaxPct: 'unknown',
  ownerRenounced: true,
  lpBurnedOrLocked: true,
  verified: true,
  transferable: true,
};

describe('enrich', () => {
  it('composes base card fields directly from the activity', async () => {
    const deps: EnrichDeps = {
      securityScan: async () => SAFE_SECURITY,
    };
    const card = await enrich(activity(), deps, SECURITY_CFG);
    expect(card.address).toBe('0xTOKEN');
    expect(card.symbol).toBe('COOL');
    expect(card.name).toBe('Cool Token');
    expect(card.liquidityUsd).toBe(5000);
    expect(card.volume1hUsd).toBe(10000);
    expect(card.buyers1h).toBe(30);
    expect(card.priceUsd).toBe(1.5);
    expect(card.fdvUsd).toBe(100000);
    expect(card.poolAddress).toBe('0xPOOL');
    expect(card.createdAt).toBe(123);
  });

  it('folds a successful securityScan result into card.security', async () => {
    const deps: EnrichDeps = {
      securityScan: async () => SAFE_SECURITY,
    };
    const card = await enrich(activity(), deps, SECURITY_CFG);
    expect(card.security).toEqual(SAFE_SECURITY);
  });

  it('degrades to an unknown Security when securityScan resolves "unknown"', async () => {
    const deps: EnrichDeps = {
      securityScan: async () => 'unknown',
    };
    const card = await enrich(activity(), deps, SECURITY_CFG);
    expect(card.security).toEqual({
      sellTaxPct: 'unknown',
      topHolderPct: 'unknown',
      riskLevel: 'unknown',
      transferable: 'unknown',
    });
  });

  it('degrades to an unknown Security when securityScan throws, and does not reject enrich', async () => {
    const deps: EnrichDeps = {
      securityScan: async () => {
        throw new Error('rpc timeout');
      },
    };
    await expect(enrich(activity(), deps, SECURITY_CFG)).resolves.toBeTruthy();
    const card = await enrich(activity(), deps, SECURITY_CFG);
    expect(card.security).toEqual({
      sellTaxPct: 'unknown',
      topHolderPct: 'unknown',
      riskLevel: 'unknown',
      transferable: 'unknown',
    });
  });

  it('holders stays "unknown" when no tokenInfo dep is provided', async () => {
    const deps: EnrichDeps = {
      securityScan: async () => SAFE_SECURITY,
    };
    const card = await enrich(activity(), deps, SECURITY_CFG);
    expect(card.holders).toBe('unknown');
  });

  it('maps a successful tokenInfo result (socials, image, gt_score) onto the card', async () => {
    const deps: EnrichDeps = {
      securityScan: async () => SAFE_SECURITY,
      tokenInfo: async () => ({
        imageUrl: 'https://img/logo.png',
        twitter: 'https://x.com/dev',
        telegram: 'https://t.me/c',
        website: 'https://cool.fun',
        gtScore: 88,
      }),
    };
    const card = await enrich(activity(), deps, SECURITY_CFG);
    expect(card.imageUrl).toBe('https://img/logo.png');
    expect(card.twitter).toBe('https://x.com/dev');
    expect(card.telegram).toBe('https://t.me/c');
    expect(card.website).toBe('https://cool.fun');
    expect(card.gtScore).toBe(88);
    expect(card.holders).toBe('unknown'); // tokenInfo no longer supplies a holders count
  });

  it('degrades to base card (holders "unknown", no socials) when tokenInfo throws, and does not reject enrich', async () => {
    const deps: EnrichDeps = {
      securityScan: async () => SAFE_SECURITY,
      tokenInfo: async () => {
        throw new Error('network error');
      },
    };
    const card = await enrich(activity(), deps, SECURITY_CFG);
    expect(card.holders).toBe('unknown');
    expect(card.imageUrl).toBeUndefined();
    expect(card.gtScore).toBeUndefined();
    expect(card.security).toEqual(SAFE_SECURITY);
  });

  it('runs securityScan and tokenInfo in parallel, not sequentially', async () => {
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const deps: EnrichDeps = {
      securityScan: async () => {
        await delay(60);
        return SAFE_SECURITY;
      },
      tokenInfo: async () => {
        await delay(60);
        return { gtScore: 7 };
      },
    };
    const start = Date.now();
    await enrich(activity(), deps, SECURITY_CFG);
    const elapsed = Date.now() - start;
    // Sequential would take ~120ms; parallel should stay well under that.
    expect(elapsed).toBeLessThan(110);
  });

  it('folds top-10 concentration into security.topHolderPct and recomputes riskLevel to "warn" when concentrated', async () => {
    const deps: EnrichDeps = {
      securityScan: async () => CLEAN_SECURITY,
      tokenInfo: async () => ({ topHolderPct: 55 }), // above SECURITY_CFG.topHolderWarnPct (25)
    };
    const card = await enrich(activity(), deps, SECURITY_CFG);
    expect(card.security?.topHolderPct).toBe(55);
    expect(card.security?.riskLevel).toBe('warn');
  });

  it('keeps riskLevel "safe" when the known top-10 concentration is under the configured bar', async () => {
    const deps: EnrichDeps = {
      securityScan: async () => CLEAN_SECURITY,
      tokenInfo: async () => ({ topHolderPct: 12 }), // under SECURITY_CFG.topHolderWarnPct (25)
    };
    const card = await enrich(activity(), deps, SECURITY_CFG);
    expect(card.security?.topHolderPct).toBe(12);
    expect(card.security?.riskLevel).toBe('safe');
  });

  it('leaves security.topHolderPct untouched when tokenInfo has no numeric topHolderPct', async () => {
    const deps: EnrichDeps = {
      securityScan: async () => CLEAN_SECURITY,
      tokenInfo: async () => ({ gtScore: 50 }),
    };
    const card = await enrich(activity(), deps, SECURITY_CFG);
    expect(card.security).toEqual(CLEAN_SECURITY);
  });
});
