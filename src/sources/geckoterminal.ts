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

/** Test-only: resets the module-scoped inter-call rate limiter's clock. `lastCallTime` is
 * real-`Date.now()`-based and shared across every `GeckoTerminal` instance in the process; a
 * test using fake timers to exercise `fetchWithRetry`'s 429-wait path needs a clean slate rather
 * than inheriting a timestamp left behind (in real or fake time) by whatever test ran before it.
 * Not called by production code. */
export function __resetRateLimiterForTests(): void {
  lastCallTime = 0;
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
 * above. 6 hours (Task 13) is the key to coverage across cycles under the Demo key's ~5-6
 * info-calls/minute ceiling: info barely changes, so a long TTL lets a slow prefetch warm a
 * token once and have it stay "fresh" (see hasFreshTokenInfo) across many following poll cycles
 * instead of re-competing for the same scarce rate-limit budget every 15 minutes. */
const TOKEN_INFO_TTL_MS = 6 * 60 * 60 * 1000;
const tokenInfoCache = new Map<string, { data: GeckoTokenInfo; expiresAt: number }>();

/** Free per-token logo lookup from a `?include=base_token` poll response's sideloaded `included`
 * array — no extra network call (Task 13 Part A). Keyed by the included token object's own `id`
 * (e.g. "robinhood_0x8ff.."), which is exactly what a pool's `relationships.base_token.data.id`
 * points at. Skips empty/`'missing.png'` images (GeckoTerminal's placeholder for "no logo") so
 * those tokens correctly fall through to "no image" rather than posting a broken placeholder. */
function buildImageMap(data: any): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(data?.included)) return map;
  for (const item of data.included) {
    if (!item || item.type !== 'token' || typeof item.id !== 'string') continue;
    const img = item.attributes?.image_url;
    if (typeof img === 'string' && img && img !== 'missing.png') {
      map.set(item.id, img);
    }
  }
  return map;
}

/** Attaches the free include-image (if any) onto an already-parsed PoolActivity, looked up by the
 * raw pool's base-token relationship id. Best-effort: no match leaves the PoolActivity unchanged
 * (imageUrl stays undefined). */
function withImage(raw: any, pool: PoolActivity, imageMap: Map<string, string>): PoolActivity {
  const baseTokenId = raw?.relationships?.base_token?.data?.id;
  const imageUrl = typeof baseTokenId === 'string' ? imageMap.get(baseTokenId) : undefined;
  return imageUrl ? { ...pool, imageUrl } : pool;
}

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

  /**
   * @param maxAttempts Defaults to 2 (trending/new pools). The info path (Task 13) passes 3 —
   *   it's the endpoint that actually gets 429'd under the Demo key's tight per-minute ceiling,
   *   so it gets the extra attempt; bumping every poll endpoint would just burn more budget.
   */
  private async fetchWithRetry(url: string, maxAttempts = 2): Promise<Response> {
    const headers: HeadersInit = {
      accept: 'application/json',
    };

    if (this.apiKey) {
      // CoinGecko Demo key header (verified live). NOT 'Authorization' — GeckoTerminal ignores
      // that, silently falling back to the shared anonymous rate limit (causes intermittent 429s
      // that leave a token's one-and-only post sparse). x-cg-demo-api-key authenticates the key.
      headers['x-cg-demo-api-key'] = this.apiKey;
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
        if (response.ok || attempt === maxAttempts) {
          return response;
        }

        if (response.status === 429) {
          // Give the shared rate-limit window a moment to clear before retrying (Task 13) —
          // helps a prefetch/info call land a slot instead of instantly re-429ing. Honors a
          // numeric Retry-After (seconds) if the server sent one, else waits 3s.
          const retryAfterSec = Number(response.headers?.get?.('retry-after'));
          const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 3000;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        // If !response.ok and not final attempt, retry
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === maxAttempts) {
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

  /**
   * Shared body for trendingPools/newPools (Task 13): appends `?include=base_token` so
   * GeckoTerminal sideloads each pool's base-token object — including its logo — in the SAME
   * response, at no extra rate-limit cost (Part A's free-logos-for-all-tokens fix). Parses each
   * raw pool via `parsePool`, then best-effort attaches the matching free image.
   */
  private async fetchPoolList(path: 'trending_pools' | 'new_pools'): Promise<PoolActivity[]> {
    const url = `${this.baseUrl}/${path}?include=base_token`;
    const response = await this.fetchWithRetry(url);

    if (!response.ok) {
      throw new Error(`GeckoTerminal API error: ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data.data)) {
      return [];
    }

    const imageMap = buildImageMap(data);
    const results: PoolActivity[] = [];
    for (const raw of data.data) {
      const parsed = parsePool(raw);
      if (parsed) results.push(withImage(raw, parsed, imageMap));
    }
    return results;
  }

  async trendingPools(): Promise<PoolActivity[]> {
    return this.fetchPoolList('trending_pools');
  }

  async newPools(): Promise<PoolActivity[]> {
    return this.fetchPoolList('new_pools');
  }

  /**
   * Best-effort token-info lookup (socials, logo, gt_score trust rating, top-10 holder
   * concentration) — GET /tokens/{address}/info, via the same fetchWithRetry (rate limiter +
   * demo-key header + timeout) the poll endpoints use, but with 3 attempts instead of 2 (Task
   * 13) — this is the endpoint that actually gets 429'd under the Demo key's ~5-6 calls/minute
   * ceiling, and fetchWithRetry now waits out a 429 before retrying, so the extra attempt has a
   * real shot at landing. Never throws: any failure (non-ok response, thrown network error,
   * malformed body) resolves to `{}` so a bad token-info fetch never blocks or fails a card.
   * Cached per lowercased address for 6 hours (see tokenInfoCache above) to avoid re-hitting a
   * rate-limited endpoint on every poll cycle.
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
      const response = await this.fetchWithRetry(url, 3);
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

  /**
   * True iff a non-expired tokenInfo cache entry exists for this address — checks the cache
   * WITHOUT fetching (Task 13). Backs runCycle's prefetch (skip addresses that are already warm)
   * and post-gate (post a trending token as soon as its info is cached, instead of waiting out
   * the grace period).
   */
  hasFreshTokenInfo(address: string): boolean {
    const cached = tokenInfoCache.get(address.toLowerCase());
    return !!cached && cached.expiresAt > Date.now();
  }
}
