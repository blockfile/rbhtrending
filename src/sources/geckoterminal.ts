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
}
