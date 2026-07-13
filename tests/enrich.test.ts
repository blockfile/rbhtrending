import { describe, it, expect } from 'vitest';
import { enrich, type EnrichDeps } from '../src/pipeline/enrich';
import type { PoolActivity, Security } from '../src/types';

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

const SAFE_SECURITY: Security = {
  sellTaxPct: 0,
  topHolderPct: 5,
  riskLevel: 'safe',
};

describe('enrich', () => {
  it('composes base card fields directly from the activity', async () => {
    const deps: EnrichDeps = {
      securityScan: async () => SAFE_SECURITY,
    };
    const card = await enrich(activity(), deps);
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
    const card = await enrich(activity(), deps);
    expect(card.security).toEqual(SAFE_SECURITY);
  });

  it('degrades to an unknown Security when securityScan resolves "unknown"', async () => {
    const deps: EnrichDeps = {
      securityScan: async () => 'unknown',
    };
    const card = await enrich(activity(), deps);
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
    await expect(enrich(activity(), deps)).resolves.toBeTruthy();
    const card = await enrich(activity(), deps);
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
    const card = await enrich(activity(), deps);
    expect(card.holders).toBe('unknown');
  });

  it('folds a successful tokenInfo result (e.g. holders) into the card', async () => {
    const deps: EnrichDeps = {
      securityScan: async () => SAFE_SECURITY,
      tokenInfo: async () => ({ holders: 42 }),
    };
    const card = await enrich(activity(), deps);
    expect(card.holders).toBe(42);
  });

  it('degrades to base card (holders "unknown") when tokenInfo throws, and does not reject enrich', async () => {
    const deps: EnrichDeps = {
      securityScan: async () => SAFE_SECURITY,
      tokenInfo: async () => {
        throw new Error('network error');
      },
    };
    const card = await enrich(activity(), deps);
    expect(card.holders).toBe('unknown');
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
        return { holders: 7 };
      },
    };
    const start = Date.now();
    await enrich(activity(), deps);
    const elapsed = Date.now() - start;
    // Sequential would take ~120ms; parallel should stay well under that.
    expect(elapsed).toBeLessThan(110);
  });
});
