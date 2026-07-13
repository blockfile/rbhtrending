import { describe, it, expect } from 'vitest';
import { parsePool, GeckoTerminal } from '../src/sources/geckoterminal';
import type { PoolActivity } from '../src/types';

describe('parsePool', () => {
  const validRawPool = {
    id: 'robinhood_0x123abc',
    type: 'pool',
    attributes: {
      address: '0xPoolAddress123',
      name: 'VEX / VIRTUAL',
      pool_created_at: '2024-01-15T10:30:00Z',
      reserve_in_usd: '125000.50',
      fdv_usd: '5000000',
      base_token_price_usd: '0.0125',
      volume_usd: {
        m5: '5000',
        h1: '50000',
        h6: '150000',
        h24: '500000',
      },
      transactions: {
        h1: {
          buys: 150,
          sells: 80,
          buyers: 120,
          sellers: 65,
        },
      },
    },
    relationships: {
      base_token: {
        data: {
          id: 'robinhood_0xBaseTokenABC123',
        },
      },
    },
  };

  it('parses a valid pool object to PoolActivity', () => {
    const result = parsePool(validRawPool);
    expect(result).not.toBeNull();
    expect(result).toEqual({
      address: '0xBaseTokenABC123',
      symbol: 'VEX',
      name: 'VEX / VIRTUAL',
      liquidityUsd: 125000.50,
      volume1hUsd: 50000,
      buyers1h: 120,
      priceUsd: 0.0125,
      fdvUsd: 5000000,
      poolAddress: '0xPoolAddress123',
      createdAt: expect.any(Number),
    });
  });

  it('converts pool_created_at ISO string to unix timestamp', () => {
    const result = parsePool(validRawPool);
    expect(result?.createdAt).toBe(new Date('2024-01-15T10:30:00Z').getTime());
  });

  it('derives symbol from name (text before /) when base token symbol not available', () => {
    const result = parsePool(validRawPool);
    expect(result?.symbol).toBe('VEX');
  });

  it('extracts base token address from relationships.base_token.data.id', () => {
    const result = parsePool(validRawPool);
    expect(result?.address).toBe('0xBaseTokenABC123');
  });

  it('uses h1 volume when available, else h24', () => {
    const withH1 = parsePool(validRawPool);
    expect(withH1?.volume1hUsd).toBe(50000);

    const withoutH1 = parsePool({
      ...validRawPool,
      attributes: {
        ...validRawPool.attributes,
        volume_usd: {
          m5: '5000',
          h24: '500000',
        },
      },
    });
    expect(withoutH1?.volume1hUsd).toBe(500000);
  });

  it('parses numeric strings to numbers', () => {
    const result = parsePool(validRawPool);
    expect(typeof result?.liquidityUsd).toBe('number');
    expect(typeof result?.fdvUsd).toBe('number');
    expect(typeof result?.priceUsd).toBe('number');
    expect(typeof result?.volume1hUsd).toBe('number');
  });

  it('returns null for null input', () => {
    expect(parsePool(null)).toBeNull();
  });

  it('returns null when attributes is missing', () => {
    expect(parsePool({ id: 'test', type: 'pool' })).toBeNull();
  });

  it('returns null when required attributes are missing', () => {
    expect(
      parsePool({
        ...validRawPool,
        attributes: { name: 'test' },
      })
    ).toBeNull();
  });

  it('returns null when base_token relationship is missing', () => {
    const poolWithoutBaseToken = {
      ...validRawPool,
      relationships: {},
    };
    expect(parsePool(poolWithoutBaseToken)).toBeNull();
  });

  it('handles missing/garbage volume data gracefully', () => {
    const poolWithoutVolume = {
      ...validRawPool,
      attributes: {
        ...validRawPool.attributes,
        volume_usd: undefined,
      },
    };
    const result = parsePool(poolWithoutVolume);
    expect(result?.volume1hUsd).toBe(0);
  });

  it('handles missing/garbage transaction data gracefully', () => {
    const poolWithoutTransactions = {
      ...validRawPool,
      attributes: {
        ...validRawPool.attributes,
        transactions: undefined,
      },
    };
    const result = parsePool(poolWithoutTransactions);
    expect(result?.buyers1h).toBe(0);
  });

  it('treats NaN and invalid numbers as 0', () => {
    const poolWithInvalidNumbers = {
      ...validRawPool,
      attributes: {
        ...validRawPool.attributes,
        reserve_in_usd: 'invalid',
        fdv_usd: 'NaN',
        base_token_price_usd: 'undefined',
      },
    };
    const result = parsePool(poolWithInvalidNumbers);
    expect(result?.liquidityUsd).toBe(0);
    expect(result?.fdvUsd).toBe(0);
    expect(result?.priceUsd).toBe(0);
  });

  it('h1-null-falls-back-to-h24: volume with h1:null falls back to h24', () => {
    const poolWithNullH1 = {
      ...validRawPool,
      attributes: {
        ...validRawPool.attributes,
        volume_usd: {
          h1: null,
          h24: '999',
        },
      },
    };
    const result = parsePool(poolWithNullH1);
    expect(result?.volume1hUsd).toBe(999);
  });

  it('createdAt NaN: garbage pool_created_at returns 0 for createdAt', () => {
    const poolWithGarbageDate = {
      ...validRawPool,
      attributes: {
        ...validRawPool.attributes,
        pool_created_at: 'not-a-valid-date-xyz',
      },
    };
    const result = parsePool(poolWithGarbageDate);
    expect(result).not.toBeNull();
    expect(result?.createdAt).toBe(0);
    expect(result?.symbol).toBe('VEX');
    expect(result?.liquidityUsd).toBe(125000.50);
  });
});

describe('GeckoTerminal', () => {
  it('trendingPools returns Promise<PoolActivity[]>', async () => {
    const mockFetch = async (url: string, opts?: RequestInit) => {
      expect(url).toContain('trending_pools');
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'robinhood_0x123',
              type: 'pool',
              attributes: {
                address: '0xPoolAddr',
                name: 'TOKEN / VIRTUAL',
                pool_created_at: '2024-01-15T10:30:00Z',
                reserve_in_usd: '100000',
                fdv_usd: '1000000',
                base_token_price_usd: '0.01',
                volume_usd: { h1: '30000' },
                transactions: { h1: { buyers: 50 } },
              },
              relationships: {
                base_token: {
                  data: { id: 'robinhood_0xTOKEN' },
                },
              },
            },
          ],
        }),
        { status: 200 }
      );
    };

    const client = new GeckoTerminal({ fetchFn: mockFetch as any });
    const result = await client.trendingPools();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0]?.symbol).toBe('TOKEN');
  });

  it('newPools returns Promise<PoolActivity[]>', async () => {
    const mockFetch = async (url: string, opts?: RequestInit) => {
      expect(url).toContain('new_pools');
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'robinhood_0x456',
              type: 'pool',
              attributes: {
                address: '0xPoolAddr2',
                name: 'NEW / VIRTUAL',
                pool_created_at: '2024-01-16T11:00:00Z',
                reserve_in_usd: '50000',
                fdv_usd: '500000',
                base_token_price_usd: '0.001',
                volume_usd: { h1: '10000' },
                transactions: { h1: { buyers: 25 } },
              },
              relationships: {
                base_token: {
                  data: { id: 'robinhood_0xNEW' },
                },
              },
            },
          ],
        }),
        { status: 200 }
      );
    };

    const client = new GeckoTerminal({ fetchFn: mockFetch as any });
    const result = await client.newPools();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0]?.symbol).toBe('NEW');
  });

  it('includes the CoinGecko demo-key header if apiKey is provided', async () => {
    let capturedHeaders: HeadersInit | undefined;
    const mockFetch = async (url: string, opts?: RequestInit) => {
      capturedHeaders = opts?.headers;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };

    const client = new GeckoTerminal({
      apiKey: 'test-key-123',
      fetchFn: mockFetch as any,
    });
    await client.trendingPools();
    expect(capturedHeaders).toEqual(
      expect.objectContaining({
        'x-cg-demo-api-key': 'test-key-123',
      })
    );
  });

  it('does not include the demo-key header if apiKey is not provided', async () => {
    let capturedHeaders: HeadersInit | undefined;
    const mockFetch = async (url: string, opts?: RequestInit) => {
      capturedHeaders = opts?.headers;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };

    const client = new GeckoTerminal({ fetchFn: mockFetch as any });
    await client.trendingPools();
    if (capturedHeaders && typeof capturedHeaders === 'object') {
      expect('x-cg-demo-api-key' in capturedHeaders).toBe(false);
    }
  });

  it('filters out null results from parsePool', async () => {
    const mockFetch = async (url: string, opts?: RequestInit) => {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'robinhood_0x123',
              type: 'pool',
              attributes: {
                address: '0xPoolAddr',
                name: 'VALID / VIRTUAL',
                pool_created_at: '2024-01-15T10:30:00Z',
                reserve_in_usd: '100000',
                fdv_usd: '1000000',
                base_token_price_usd: '0.01',
                volume_usd: { h1: '30000' },
                transactions: { h1: { buyers: 50 } },
              },
              relationships: {
                base_token: {
                  data: { id: 'robinhood_0xVALID' },
                },
              },
            },
            {
              id: 'robinhood_0x456',
              type: 'pool',
              // missing required fields
            },
          ],
        }),
        { status: 200 }
      );
    };

    const client = new GeckoTerminal({ fetchFn: mockFetch as any });
    const result = await client.trendingPools();
    expect(result.length).toBe(1);
    expect(result[0]?.symbol).toBe('VALID');
  });

  it('retry-after-thrown-error: fetchFn that throws on call 1 retries and succeeds on call 2', async () => {
    let callCount = 0;
    const mockFetch = async (url: string, opts?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Network error on first attempt');
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'robinhood_0x789',
              type: 'pool',
              attributes: {
                address: '0xPoolAddr3',
                name: 'RETRY / VIRTUAL',
                pool_created_at: '2024-01-17T12:00:00Z',
                reserve_in_usd: '75000',
                fdv_usd: '750000',
                base_token_price_usd: '0.005',
                volume_usd: { h1: '20000' },
                transactions: { h1: { buyers: 35 } },
              },
              relationships: {
                base_token: {
                  data: { id: 'robinhood_0xRETRY' },
                },
              },
            },
          ],
        }),
        { status: 200 }
      );
    };

    const client = new GeckoTerminal({ fetchFn: mockFetch as any });
    const result = await client.trendingPools();
    expect(callCount).toBe(2);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0]?.symbol).toBe('RETRY');
  });
});

describe('GeckoTerminal.tokenInfo', () => {
  // Fixture shaped exactly like the live-verified /tokens/{addr}/info response (see
  // task-12-brief.md's "Verified GeckoTerminal fields" probe results).
  const infoFixture = {
    data: {
      attributes: {
        image_url: 'https://assets.geckoterminal.com/logo.png',
        websites: ['https://vex.fun'],
        twitter_handle: '@vexcoin',
        telegram_handle: 'vexcoin_tg',
        gt_score: 72.4,
        holders: {
          count: null,
          distribution_percentage: { top_10: '18.1768' },
        },
        developer_holding_percentage: null,
        is_honeypot: 'unknown',
      },
    },
  };

  it('maps the verified info fields (image, socials, gt_score rounded, top-10 parsed)', async () => {
    let calls = 0;
    const addr = '0xInfoTokenAAAA1111111111111111111111111';
    const mockFetch = async (url: string) => {
      calls++;
      expect(url).toContain(`/tokens/${addr}/info`);
      return new Response(JSON.stringify(infoFixture), { status: 200 });
    };
    const client = new GeckoTerminal({ fetchFn: mockFetch as any });
    const info = await client.tokenInfo(addr);
    expect(info).toEqual({
      imageUrl: 'https://assets.geckoterminal.com/logo.png',
      twitter: 'https://x.com/vexcoin',
      telegram: 'https://t.me/vexcoin_tg',
      website: 'https://vex.fun',
      gtScore: 72,
      topHolderPct: 18.1768,
    });
    expect(calls).toBe(1);
  });

  it('caches per address for the TTL — a second call within the window does not re-fetch', async () => {
    let calls = 0;
    const addr = '0xCacheHitTokenBBBB2222222222222222222222';
    const mockFetch = async () => {
      calls++;
      return new Response(JSON.stringify(infoFixture), { status: 200 });
    };
    const client = new GeckoTerminal({ fetchFn: mockFetch as any });
    const first = await client.tokenInfo(addr);
    const second = await client.tokenInfo(addr);
    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  it('returns {} without throwing on a non-ok response (e.g. 500)', async () => {
    const addr = '0x500TokenCCCC3333333333333333333333333333';
    const mockFetch = async () => new Response('server error', { status: 500 });
    const client = new GeckoTerminal({ fetchFn: mockFetch as any });
    await expect(client.tokenInfo(addr)).resolves.toEqual({});
  });

  it('returns {} without throwing when fetch itself rejects', async () => {
    const addr = '0xThrowTokenDDDD4444444444444444444444444';
    const mockFetch = async () => {
      throw new Error('network down');
    };
    const client = new GeckoTerminal({ fetchFn: mockFetch as any });
    await expect(client.tokenInfo(addr)).resolves.toEqual({});
  });

  it('omits empty/missing fields instead of mapping them to falsy placeholders', async () => {
    const addr = '0xPartialTokenEEEE5555555555555555555555';
    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          data: { attributes: { image_url: '', websites: [], gt_score: null, holders: {} } },
        }),
        { status: 200 },
      );
    const client = new GeckoTerminal({ fetchFn: mockFetch as any });
    const info = await client.tokenInfo(addr);
    expect(info).toEqual({});
  });
});
