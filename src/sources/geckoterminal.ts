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
      if (attrs.volume_usd.h1 !== undefined) {
        volume1hUsd = parseFloat(attrs.volume_usd.h1) || 0;
      } else if (attrs.volume_usd.h24 !== undefined) {
        volume1hUsd = parseFloat(attrs.volume_usd.h24) || 0;
      }
    }

    // Handle buyers in 1h
    let buyers1h = 0;
    if (attrs.transactions?.h1?.buyers !== undefined) {
      buyers1h = Number(attrs.transactions.h1.buyers) || 0;
    }

    // Convert pool_created_at to unix timestamp
    const createdAt = new Date(attrs.pool_created_at).getTime();

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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      // Enforce rate limit
      await rateLimit();

      // First attempt
      let response = await this.fetchFn(url, {
        headers,
        signal: controller.signal,
      });

      // Retry once on failure
      if (!response.ok) {
        await rateLimit();
        response = await this.fetchFn(url, {
          headers,
          signal: controller.signal,
        });
      }

      return response;
    } finally {
      clearTimeout(timeout);
    }
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
