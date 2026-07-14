import type { OrderRow } from '../db/index';
import type { GmgnToken, TrendingConfig } from '../types';
import { escapeHtml, usdOrQ, GMGN_TOKEN_BASE } from '../telegram';
import { passesGate } from '../pipeline/trending';
import { assess } from '../checks/assess';

/**
 * Prepare the organic leaderboard pool from a raw GMGN trending list. GMGN ranks by raw
 * activity/hotness, which honeypots, corpses, and wash campaigns game — so instead of trusting
 * that order we apply the SAME quality bar as the alert pipeline: drop anything that fails the
 * trending gate (honeypots, dead-bounces far below ATH, thin liquidity) or grades `danger`, then
 * sort what's left by our own `assess()` score (highest first). The sort is stable, so tokens
 * with equal scores keep their incoming GMGN order.
 */
export function rankOrganic(tokens: GmgnToken[], cfg: TrendingConfig, now: number): GmgnToken[] {
  return tokens
    .map((t) => ({ t, a: assess(t) }))
    .filter(({ t, a }) => passesGate(t, cfg, now) && a.grade !== 'danger')
    .sort((x, y) => y.a.score - x.a.score)
    .map(({ t }) => t);
}

/**
 * Render the pinned "ROBINHOOD TRENDING" Top-N leaderboard: ⭐-labelled paid slots hold their
 * purchased ranks, every other rank fills from `organic` in the given order (already filtered
 * and score-ranked by `rankOrganic` — not GMGN's raw hotness order), skipping addresses that
 * already hold a paid slot. A paid token's market cap is looked up from the organic list when
 * present; ranks with no token to show are omitted rather than rendered empty. The footer
 * discloses ⭐ and deep-links the order bot.
 */
export function formatLeaderboard(
  paid: OrderRow[],
  organic: GmgnToken[],
  size: number,
  botUsername: string,
): string {
  const paidByRank = new Map(paid.map((o) => [o.rank, o]));
  const paidAddrs = new Set(paid.map((o) => o.address.toLowerCase()));
  const mcByAddr = new Map(organic.map((t) => [t.address.toLowerCase(), t.marketCapUsd]));
  const pool = organic.filter((t) => !paidAddrs.has(t.address.toLowerCase()));

  const row = (rank: number, star: boolean, symbol: string, address: string, mc: number | undefined): string => {
    const link = `<a href="${GMGN_TOKEN_BASE}/${address}">$${escapeHtml(symbol)}</a>`;
    const mcSeg = mc !== undefined ? ` · ${usdOrQ(mc)}` : '';
    return `${rank}. ${star ? '⭐ ' : ''}${link}${mcSeg}`;
  };

  const rows: string[] = [];
  let next = 0;
  for (let rank = 1; rank <= size; rank++) {
    const p = paidByRank.get(rank);
    if (p) {
      rows.push(row(rank, true, p.symbol, p.address, mcByAddr.get(p.address.toLowerCase())));
    } else if (next < pool.length) {
      const t = pool[next++];
      rows.push(row(rank, false, t.symbol, t.address, t.marketCapUsd));
    }
  }

  return [
    '🔥 <b>ROBINHOOD TRENDING</b>',
    '',
    ...rows,
    '',
    `⭐ = promoted · <a href="https://t.me/${botUsername}?start=trend">Buy a trending slot</a>`,
  ].join('\n');
}
