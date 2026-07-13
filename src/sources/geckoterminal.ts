import type { PoolActivity } from '../types';

export function parsePool(raw: any): PoolActivity | null {
  try {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const attrs = raw.attributes;
    const rels = raw.relationships;

    if (!attrs || typeof attrs !== 'object') {
      return null;
    }

    // Validate required fields
    if (
      !attrs.address ||
      !attrs.name ||
      !attrs.pool_created_at ||
      !attrs.reserve_in_usd ||
      !attrs.fdv_usd ||
      !attrs.base_token_price_usd
    ) {
      return null;
    }

    // Extract base token address from relationships
    if (!rels?.base_token?.data?.id) {
      return null;
    }

    const baseTokenId = rels.base_token.data.id;
    const addressParts = baseTokenId.split('_');
    if (addressParts.length < 2) {
      return null;
    }
    const address = addressParts[1];

    // Extract symbol from name (text before " / ")
    const nameParts = attrs.name.split(' / ');
    const symbol = nameParts[0] || '';

    if (!symbol) {
      return null;
    }

    // Parse numeric fields
    const liquidityUsd = parseFloat(attrs.reserve_in_usd) || 0;
    const fdvUsd = parseFloat(attrs.fdv_usd) || 0;
    const priceUsd = parseFloat(attrs.base_token_price_usd) || 0;

    // Handle volume (prefer h1, fall back to h24)
    let volume1hUsd = 0;
    if (attrs.volume_usd) {
      const h1 = parseFloat(attrs.volume_usd.h1);
      const h24 = parseFloat(attrs.volume_usd.h24);
      if (Number.isFinite(h1)) {
        volume1hUsd = h1;
      } else if (Number.isFinite(h24)) {
        volume1hUsd = h24;
      }
    }

    // Handle buyers in 1h
    let buyers1h = 0;
    if (attrs.transactions?.h1?.buyers !== undefined) {
      buyers1h = Number(attrs.transactions.h1.buyers) || 0;
    }

    // Convert pool_created_at to unix timestamp
    const ts = new Date(attrs.pool_created_at).getTime();
    const createdAt = Number.isNaN(ts) ? 0 : ts;

    return {
      address,
      symbol,
      name: attrs.name,
      liquidityUsd,
      volume1hUsd,
      buyers1h,
      priceUsd,
      fdvUsd,
      poolAddress: attrs.address,
      createdAt,
    };
  } catch {
    return null;
  }
}

// Rate limiter: track last call time, enforce 2s minimum gap
let lastCallTime = 0;
const MIN_GAP_MS = 2000;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_GAP_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_GAP_MS - elapsed));
  }
  lastCallTime = Date.now();
}

export interface GeckoTerminalOptions {
  apiKey?: string;
  fetchFn?: typeof fetch;
}

export interface GeckoTokenInfo {
  imageUrl?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  gtScore?: number;
  topHolderPct?: number;
}

/** Module-scoped cache for tokenInfo — token info (socials/trust score/holder concentration)
 * barely changes cycle to cycle, so re-fetching it every poll would just burn rate-limit budget
 * for no benefit. Shared across GeckoTerminal instances, same pattern as the rateLimit() gate
 * above. 15 minutes comfortably outlives a poll cycle (pollSeconds is on the order of tens of
 * seconds) while still refreshing well within a trading session. */
const TOKEN_INFO_TTL_MS = 15 * 60 * 1000;
const tokenInfoCache = new Map<string, { data: GeckoTokenInfo; expiresAt: number }>();

function mapTokenInfo(attrs: any): GeckoTokenInfo {
  const info: GeckoTokenInfo = {};

  if (typeof attrs.image_url === 'string' && attrs.image_url) {
    info.imageUrl = attrs.image_url;
  }
  if (typeof attrs.twitter_handle === 'string' && attrs.twitter_handle) {
    info.twitter = `https://x.com/${attrs.twitter_handle.replace(/^@/, '')}`;
  }
  if (typeof attrs.telegram_handle === 'string' && attrs.telegram_handle) {
    info.telegram = `https://t.me/${attrs.telegram_handle}`;
  }
  if (Array.isArray(attrs.websites) && typeof attrs.websites[0] === 'string' && attrs.websites[0]) {
    info.website = attrs.websites[0];
  }
  if (typeof attrs.gt_score === 'number' && Number.isFinite(attrs.gt_score)) {
    info.gtScore = Math.round(attrs.gt_score);
  }
  const topHolderPct = parseFloat(attrs.holders?.distribution_percentage?.top_10);
  if (Number.isFinite(topHolderPct)) {
    info.topHolderPct = topHolderPct;
  }

  return info;
}

export class GeckoTerminal {
  private apiKey: string;
  private fetchFn: typeof fetch;
  private baseUrl = 'https://api.geckoterminal.com/api/v2/networks/robinhood';

  constructor(opts?: GeckoTerminalOptions) {
    this.apiKey = opts?.apiKey || '';
    this.fetchFn = opts?.fetchFn || globalThis.fetch;
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    const headers: HeadersInit = {
      accept: 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = this.apiKey;
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      try {
        // Enforce rate limit
        await rateLimit();

        const response = await this.fetchFn(url, {
          headers,
          signal: controller.signal,
        });

        // Return on success or after final attempt
        if (response.ok || attempt === 2) {
          return response;
        }
        // If !response.ok and not final attempt, retry
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === 2) {
          // Final attempt threw, rethrow
          throw lastError;
        }
        // Otherwise, retry on next iteration
      } finally {
        clearTimeout(timeout);
      }
    }

    // Should not reach here
    throw lastError || new Error('Fetch failed after retries');
  }

  async trendingPools(): Promise<PoolActivity[]> {
    const url = `${this.baseUrl}/trending_pools`;
    const response = await this.fetchWithRetry(url);

    if (!response.ok) {
      throw new Error(`GeckoTerminal API error: ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data.data)) {
      return [];
    }

    return data.data.map((raw: any) => parsePool(raw)).filter((p: PoolActivity | null) => p !== null);
  }

  async newPools(): Promise<PoolActivity[]> {
    const url = `${this.baseUrl}/new_pools`;
    const response = await this.fetchWithRetry(url);

    if (!response.ok) {
      throw new Error(`GeckoTerminal API error: ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data.data)) {
      return [];
    }

    return data.data.map((raw: any) => parsePool(raw)).filter((p: PoolActivity | null) => p !== null);
  }

  /**
   * Best-effort token-info lookup (socials, logo, gt_score trust rating, top-10 holder
   * concentration) — GET /tokens/{address}/info, via the same fetchWithRetry (rate limiter +
   * Authorization header + timeout) the poll endpoints use. Never throws: any failure (non-ok
   * response, thrown network error, malformed body) resolves to `{}` so a bad token-info fetch
   * never blocks or fails a card. Cached per lowercased address for 15 minutes (see
   * tokenInfoCache above) to avoid re-hitting a rate-limited endpoint on every poll cycle.
   */
  async tokenInfo(address: string): Promise<GeckoTokenInfo> {
    const key = address.toLowerCase();
    const now = Date.now();
    const cached = tokenInfoCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    try {
      const url = `${this.baseUrl}/tokens/${address}/info`;
      const response = await this.fetchWithRetry(url);
      if (!response.ok) return {};

      const data = await response.json();
      const attrs = data?.data?.attributes;
      if (!attrs || typeof attrs !== 'object') return {};

      const info = mapTokenInfo(attrs);
      tokenInfoCache.set(key, { data: info, expiresAt: now + TOKEN_INFO_TTL_MS });
      return info;
    } catch {
      return {};
    }
  }
}
