import type { GmgnToken } from '../types';

/** Pure security/score verdict derived from a single GMGN `market/rank` row. The rule table
 * lives in the README ("Security badge & score"); it supersedes the original task-g2-brief.md
 * rubric, which pinned nearly every Robinhood-chain token at 100 (see below). */
export interface Assessment {
  score: number;
  grade: 'safe' | 'warn' | 'danger';
  flags: string[];
}

/** Proportional penalty: `perUnit` points for every unit of `value` above `freeFloor`,
 * rounded, capped at `cap`. The floor keeps chain-typical values penalty-free so the score
 * discriminates instead of docking everyone. */
function over(value: number, freeFloor: number, perUnit: number, cap: number): number {
  return Math.min(cap, Math.round(Math.max(0, value - freeFloor) * perUnit));
}

/**
 * Grades a `GmgnToken` into a score (0-100), a tier (safe/warn/danger), and a list of short
 * red-flag labels. Pure — no I/O. `flags` are pushed in a fixed order since the card renders
 * them joined by " · " and the order communicates rough severity.
 *
 * On Robinhood chain every token launches through the same launchpad, so the classic security
 * flags (honeypot/taxes/LP-lock/renounced/verified) come back identically "good" for the whole
 * feed — an all-security rubric scored ~everything 100. The score therefore starts at a
 * baseline of 88 and moves on the signals that actually vary between tokens (holder
 * concentration, dev/insider/bundled supply, bot-trade share, entrapment, snipers, smart-money
 * and KOL depth); the fixed security penalties are kept for the odd non-launchpad token where
 * they do fire. 100 now means "clean AND strongly backed", not "no rug flags".
 */
export function assess(t: GmgnToken): Assessment {
  const flags: string[] = [];
  if (t.honeypot) flags.push('honeypot');
  if (t.sellTaxPct > 10) flags.push(`sell tax ${Math.round(t.sellTaxPct)}%`);
  if (t.lpLockedPct < 50) flags.push('LP not locked');
  if (!t.renounced) flags.push('owner active');
  if (!t.verified) flags.push('unverified');
  if (t.top10Pct > 50) flags.push(`top 10 owns ${Math.round(t.top10Pct)}%`);
  if (t.devHoldPct > 15) flags.push(`dev holds ${Math.round(t.devHoldPct)}%`);
  if (t.washTrading) flags.push('wash trading');
  if (t.botDegenPct > 50) flags.push(`bots ${Math.round(t.botDegenPct)}%`);
  if (t.ratTraderPct > 20) flags.push(`insiders ${Math.round(t.ratTraderPct)}%`);
  if (t.sniperCount >= 20) flags.push(`${t.sniperCount} snipers`);
  // Informational (no score deduction): the gate already blocks OLD deep-drawdown tokens, so in
  // practice this shows only on young ones — where "-85% from ATH" is exactly what a buyer
  // wants to see before aping a retrace. 20% matches the gate's default minMcOfAthPct.
  if (t.athMarketCapUsd > 0 && t.marketCapUsd < t.athMarketCapUsd * 0.2) {
    flags.push(`${Math.round(((t.marketCapUsd - t.athMarketCapUsd) / t.athMarketCapUsd) * 100)}% from ATH`);
  }

  let score = 88;

  // fixed security penalties — uniform on this chain's launchpad tokens, but kept so a
  // non-standard token that DOES trip one still craters
  if (t.honeypot) score -= 80;
  if (!t.renounced) score -= 12;
  if (!t.verified) score -= 8;
  if (t.lpLockedPct < 20) score -= 30;
  else if (t.lpLockedPct < 50) score -= 15;
  if (t.sellTaxPct > 30) score -= 30;
  else if (t.sellTaxPct > 10) score -= 15;
  if (t.washTrading) score -= 20;
  if (t.rugRatioPct > 50) score -= 20;

  // holder distribution (proportional — these vary token to token)
  score -= over(t.top10Pct, 20, 0.5, 30);
  score -= over(t.devHoldPct, 2, 0.6, 20);
  if (t.holderCount < 100) score -= 5;

  // trade quality (proportional)
  score -= over(t.botDegenPct, 20, 0.3, 15);
  score -= over(t.ratTraderPct, 0, 0.5, 15);
  score -= over(t.entrapmentPct, 40, 0.2, 10);
  score -= over(t.sniperCount, 0, 0.25, 8);
  score -= over(t.bundlerRatePct, 5, 0.5, 5);

  // depth bonuses (graduated; max +12, so only a penalty-free token can reach 100)
  score += Math.min(7, Math.round(t.smartMoneyCount * 0.3));
  score += Math.min(5, Math.round(t.kolCount * 0.2));

  score = Math.round(Math.min(100, Math.max(0, score)));

  const grade: Assessment['grade'] =
    t.honeypot || t.sellTaxPct > 30 || t.lpLockedPct < 20 || score < 40
      ? 'danger'
      : flags.length > 0 || score < 70
        ? 'warn'
        : 'safe';

  return { score, grade, flags };
}
