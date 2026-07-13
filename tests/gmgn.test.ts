import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapToken, GmgnClient } from '../src/sources/gmgn';

const FIXTURE = JSON.parse(readFileSync('tests/fixtures/gmgn-token.json', 'utf8'));

describe('mapToken', () => {
  it('maps the key fields from the live-sample fixture', () => {
    const result = mapToken(FIXTURE);
    expect(result).not.toBeNull();
    expect(result?.address).toBe('0x6e7e0db14d23144ef3e78d3294aa408ac38427b8');
    expect(result?.symbol).toBe('BLEP');
    expect(result?.name).toBe('BLEEEP by Virtuals');
    expect(result?.logo).toBe('https://gmgn.ai/external-res/b45b116bdea22b678c64e6d04fe04e72_v2.webp');
    expect(result?.priceUsd).toBe(0.000560574);
    expect(result?.priceChange1hPct).toBe(2102.81);
    expect(result?.volumeUsd).toBe(656572);
    expect(result?.liquidityUsd).toBe(76588);
    expect(result?.marketCapUsd).toBe(530255);
    expect(result?.athMarketCapUsd).toBe(418045);
    expect(result?.swaps).toBe(4287);
    expect(result?.buys).toBe(2370);
    expect(result?.sells).toBe(1917);
    expect(result?.holderCount).toBe(394);
  });

  it('scales top_10_holder_rate (0..1 fraction) to a 0..100 percent', () => {
    const result = mapToken(FIXTURE);
    expect(result?.top10Pct).toBeCloseTo(FIXTURE.top_10_holder_rate * 100, 10);
    expect(result?.top10Pct).toBeCloseTo(65.31, 10);
  });

  it('converts creation_timestamp (unix seconds) to milliseconds', () => {
    const result = mapToken(FIXTURE);
    expect(result?.createdAt).toBe(FIXTURE.creation_timestamp * 1000);
  });

  it('maps the honeypot/renounced/verified booleans from the 0/1 flags', () => {
    const result = mapToken(FIXTURE);
    expect(result?.honeypot).toBe(false); // is_honeypot: 0
    expect(result?.renounced).toBe(true); // is_renounced: 1
    expect(result?.verified).toBe(true); // is_open_source: 1
  });

  it('parses buy_tax/sell_tax numeric-string fractions to percents', () => {
    const result = mapToken(FIXTURE);
    expect(result?.buyTaxPct).toBe(0);
    expect(result?.sellTaxPct).toBe(0);
  });

  it('scales lock_percent, dev_team_hold_rate, rug_ratio, burn_ratio to percents', () => {
    const result = mapToken(FIXTURE);
    expect(result?.lpLockedPct).toBeCloseTo(95, 10); // lock_percent: 0.95
    expect(result?.devHoldPct).toBeCloseTo(10, 10); // dev_team_hold_rate: 0.1
    expect(result?.rugRatioPct).toBe(0); // rug_ratio: 0
    expect(result?.burnPct).toBe(0); // burn_ratio: 0
  });

  it('maps smart-money/KOL/sniper depth counts and bundler rate', () => {
    const result = mapToken(FIXTURE);
    expect(result?.smartMoneyCount).toBe(16); // smart_degen_count
    expect(result?.kolCount).toBe(17); // renowned_count
    expect(result?.sniperCount).toBe(0); // sniper_count
    expect(result?.bundlerRatePct).toBe(0); // bundler_rate: 0
    expect(result?.washTrading).toBe(false); // is_wash_trading
    expect(result?.hotLevel).toBe(3); // hot_level
  });

  it('maps twitter/website as-is when non-empty, and leaves telegram undefined when empty', () => {
    const result = mapToken(FIXTURE);
    expect(result?.twitter).toBe('https://x.com/bleeep_xyz');
    expect(result?.website).toBe('https://www.bleeep.xyz/');
    expect(result?.telegram).toBeUndefined(); // fixture's telegram is ""
  });

  it('leaves logo undefined when the raw logo string is empty', () => {
    const result = mapToken({ ...FIXTURE, logo: '' });
    expect(result?.logo).toBeUndefined();
  });

  it('returns null for null input', () => {
    expect(mapToken(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(mapToken(undefined)).toBeNull();
  });

  it('returns null when address is missing', () => {
    const { address, ...rest } = FIXTURE;
    expect(mapToken(rest)).toBeNull();
  });

  it('returns null when symbol is missing', () => {
    const { symbol, ...rest } = FIXTURE;
    expect(mapToken(rest)).toBeNull();
  });

  it('returns null for an empty object', () => {
    expect(mapToken({})).toBeNull();
  });

  it('coerces non-finite numeric fields to 0 instead of NaN', () => {
    const result = mapToken({ ...FIXTURE, price: 'not-a-number', volume: null, holder_count: undefined });
    expect(result?.priceUsd).toBe(0);
    expect(result?.volumeUsd).toBe(0);
    expect(result?.holderCount).toBe(0);
  });

  it('clamps GMGN -1 "unknown" tax/ratio sentinels to 0 (not -100%)', () => {
    const result = mapToken({ ...FIXTURE, buy_tax: '-1', sell_tax: '-1', lock_percent: -1, dev_team_hold_rate: -1 });
    expect(result?.buyTaxPct).toBe(0);
    expect(result?.sellTaxPct).toBe(0);
    expect(result?.lpLockedPct).toBe(0);
    expect(result?.devHoldPct).toBe(0);
  });

  it('parses a real fractional tax (0.03 -> 3%)', () => {
    const result = mapToken({ ...FIXTURE, buy_tax: '0.03', sell_tax: '0.06' });
    expect(result?.buyTaxPct).toBeCloseTo(3, 5);
    expect(result?.sellTaxPct).toBeCloseTo(6, 5);
  });

  it('falls back to symbol when name is missing/empty', () => {
    expect(mapToken({ ...FIXTURE, name: undefined })?.name).toBe(FIXTURE.symbol);
    expect(mapToken({ ...FIXTURE, name: '' })?.name).toBe(FIXTURE.symbol);
  });
});

describe('GmgnClient.trending', () => {
  function envelope(tokens: unknown[]) {
    return { code: 0, data: { code: 0, message: 'success', data: { rank: tokens } } };
  }

  it('unwraps the double-wrapped envelope and returns mapped tokens', async () => {
    const mockFetch = async () => new Response(JSON.stringify(envelope([FIXTURE])), { status: 200 });
    const client = new GmgnClient('test-api-key', mockFetch as unknown as typeof fetch);
    const result = await client.trending();
    expect(result.length).toBe(1);
    expect(result[0]?.symbol).toBe('BLEP');
  });

  it('sends the required query params and the X-APIKEY header', async () => {
    let capturedUrl = '';
    let capturedHeaders: HeadersInit | undefined;
    const mockFetch = async (url: string | URL, opts?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = opts?.headers;
      return new Response(JSON.stringify(envelope([FIXTURE])), { status: 200 });
    };
    const client = new GmgnClient('test-api-key', mockFetch as unknown as typeof fetch);
    await client.trending('1h', 100);

    expect(capturedUrl).toContain('chain=robinhood');
    expect(capturedUrl).toContain('interval=1h');
    expect(capturedUrl).toContain('limit=100');
    expect(capturedUrl).toMatch(/timestamp=\d+/);
    expect(capturedUrl).toMatch(/client_id=[0-9a-f-]{36}/);
    expect(capturedHeaders).toEqual(expect.objectContaining({ 'X-APIKEY': 'test-api-key' }));
  });

  it('filters out null mapToken results from the rank array', async () => {
    const mockFetch = async () => new Response(JSON.stringify(envelope([FIXTURE, {}, null])), { status: 200 });
    const client = new GmgnClient('test-api-key', mockFetch as unknown as typeof fetch);
    const result = await client.trending();
    expect(result.length).toBe(1);
  });

  it('returns [] (never throws) when fetch itself rejects', async () => {
    const mockFetch = async () => {
      throw new Error('network down');
    };
    const client = new GmgnClient('test-api-key', mockFetch as unknown as typeof fetch);
    await expect(client.trending()).resolves.toEqual([]);
  });

  it('returns [] when the outer code is non-zero', async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ code: 1, data: { code: 0, message: 'fail', data: { rank: [FIXTURE] } } }), { status: 200 });
    const client = new GmgnClient('test-api-key', mockFetch as unknown as typeof fetch);
    await expect(client.trending()).resolves.toEqual([]);
  });

  it('returns [] when the inner data.code is non-zero', async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ code: 0, data: { code: 1, message: 'fail', data: { rank: [FIXTURE] } } }), { status: 200 });
    const client = new GmgnClient('test-api-key', mockFetch as unknown as typeof fetch);
    await expect(client.trending()).resolves.toEqual([]);
  });

  it('returns [] when the response is a non-ok HTTP status', async () => {
    const mockFetch = async () => new Response('server error', { status: 500 });
    const client = new GmgnClient('test-api-key', mockFetch as unknown as typeof fetch);
    await expect(client.trending()).resolves.toEqual([]);
  });

  it('returns [] when the shape is unexpected (rank missing/not an array)', async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ code: 0, data: { code: 0, message: 'success', data: {} } }), { status: 200 });
    const client = new GmgnClient('test-api-key', mockFetch as unknown as typeof fetch);
    await expect(client.trending()).resolves.toEqual([]);
  });

  it('returns [] when the response body is not valid JSON', async () => {
    const mockFetch = async () => new Response('not json', { status: 200 });
    const client = new GmgnClient('test-api-key', mockFetch as unknown as typeof fetch);
    await expect(client.trending()).resolves.toEqual([]);
  });
});
