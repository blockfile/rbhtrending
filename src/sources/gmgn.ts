import type { GmgnToken } from '../types';
import { log } from '../logger';

/** Coerces a raw numeric-ish value to a finite number, defaulting to 0 (NaN/undefined/null/
 * garbage strings all collapse to 0 rather than propagating NaN into a posted card). */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Same as `num`, but for values GMGN sends as numeric strings representing a 0..1 fraction
 * (e.g. `buy_tax`/`sell_tax`) — parses then scales to a 0..100 percent. */
function pctFromFractionString(v: unknown): number {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n * 100 : 0;
}

/** A raw 0..1 fraction (already a number) scaled to a 0..100 percent, with a finite guard. */
function pctFromFraction(v: unknown): number {
  const n = num(v);
  return Number.isFinite(n) ? n * 100 : 0;
}

/** Non-empty-string guard used for the optional social/logo fields — GMGN sends `""` (not
 * absence) for a socials field the token doesn't have, and that must map to `undefined`, not
 * the empty string. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Maps one raw GMGN `market/rank` row to a `GmgnToken`. Pure function — no I/O, safe to reuse
 * directly in tests. Returns `null` if `raw` is falsy or missing the two fields a card can't be
 * built without (`address`, `symbol`).
 */
export function mapToken(raw: any): GmgnToken | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.address || !raw.symbol) return null;

  return {
    address: raw.address,
    name: raw.name,
    symbol: raw.symbol,
    logo: str(raw.logo),
    priceUsd: num(raw.price),
    priceChange1hPct: num(raw.price_change_percent1h),
    volumeUsd: num(raw.volume),
    liquidityUsd: num(raw.liquidity),
    marketCapUsd: num(raw.market_cap),
    athMarketCapUsd: num(raw.history_highest_market_cap),
    swaps: num(raw.swaps),
    buys: num(raw.buys),
    sells: num(raw.sells),
    holderCount: num(raw.holder_count),
    top10Pct: pctFromFraction(raw.top_10_holder_rate),
    createdAt: num(raw.creation_timestamp) * 1000,
    twitter: str(raw.twitter_username),
    telegram: str(raw.telegram),
    website: str(raw.website),
    honeypot: raw.is_honeypot === 1,
    buyTaxPct: pctFromFractionString(raw.buy_tax),
    sellTaxPct: pctFromFractionString(raw.sell_tax),
    renounced: raw.is_renounced === 1,
    verified: raw.is_open_source === 1,
    lpLockedPct: pctFromFraction(raw.lock_percent),
    devHoldPct: pctFromFraction(raw.dev_team_hold_rate),
    rugRatioPct: pctFromFraction(raw.rug_ratio),
    burnPct: pctFromFraction(raw.burn_ratio),
    smartMoneyCount: num(raw.smart_degen_count),
    kolCount: num(raw.renowned_count),
    sniperCount: num(raw.sniper_count),
    bundlerRatePct: pctFromFraction(raw.bundler_rate),
    washTrading: raw.is_wash_trading === true,
    hotLevel: num(raw.hot_level),
  };
}

export class GmgnClient {
  constructor(
    private apiKey: string,
    private fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  /**
   * Best-effort trending fetch — GET /v1/market/rank on the `robinhood` chain. Never throws:
   * any failure (network error, non-ok status, malformed body, unexpected envelope shape,
   * either wrapper's `code !== 0`) resolves to `[]` after logging a warning, so a bad GMGN call
   * never blocks or crashes the poll cycle.
   */
  async trending(interval = '1h', limit = 100): Promise<GmgnToken[]> {
    const url = new URL('https://openapi.gmgn.ai/v1/market/rank');
    url.searchParams.set('chain', 'robinhood');
    url.searchParams.set('interval', interval);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)));
    url.searchParams.set('client_id', crypto.randomUUID());

    try {
      const response = await this.fetchFn(url.toString(), {
        headers: { 'X-APIKEY': this.apiKey },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        log('warn', `GMGN trending: HTTP ${response.status}`);
        return [];
      }

      const body = await response.json();
      if (body?.code !== 0) {
        log('warn', `GMGN trending: outer code ${body?.code}`);
        return [];
      }
      if (body.data?.code !== 0) {
        log('warn', `GMGN trending: inner code ${body?.data?.code} (${body?.data?.message})`);
        return [];
      }

      const rank = body.data?.data?.rank;
      if (!Array.isArray(rank)) {
        log('warn', 'GMGN trending: rank is not an array');
        return [];
      }

      const results: GmgnToken[] = [];
      for (const raw of rank) {
        const token = mapToken(raw);
        if (token) results.push(token);
      }
      return results;
    } catch (err) {
      log('warn', `GMGN trending failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
}
