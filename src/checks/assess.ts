import type { GmgnToken } from '../types';

/** Pure security/score verdict derived from a single GMGN `market/rank` row. See
 * task-g2-brief.md for the exact rule table this implements. */
export interface Assessment {
  score: number;
  grade: 'safe' | 'warn' | 'danger';
  flags: string[];
}

/**
 * Grades a `GmgnToken` into a score (0-100), a tier (safe/warn/danger), and a list of short
 * red-flag labels. Pure — no I/O. `flags` are pushed in a fixed order (see brief) since the
 * card renders them joined by " · " and the order communicates rough severity.
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

  const grade: Assessment['grade'] =
    t.honeypot || t.sellTaxPct > 30 || t.lpLockedPct < 20
      ? 'danger'
      : flags.length > 0
        ? 'warn'
        : 'safe';

  let score = 100;
  if (t.honeypot) score -= 80;
  if (!t.renounced) score -= 12;
  if (!t.verified) score -= 8;
  if (t.lpLockedPct < 20) score -= 30;
  else if (t.lpLockedPct < 50) score -= 15;
  if (t.sellTaxPct > 30) score -= 30;
  else if (t.sellTaxPct > 10) score -= 15;
  if (t.top10Pct > 70) score -= 25;
  else if (t.top10Pct > 50) score -= 12;
  if (t.devHoldPct > 15) score -= 12;
  if (t.washTrading) score -= 20;
  if (t.rugRatioPct > 50) score -= 20;
  if (t.smartMoneyCount >= 10) score += 5;
  if (t.kolCount >= 10) score += 5;

  score = Math.round(Math.min(100, Math.max(0, score)));

  return { score, grade, flags };
}
