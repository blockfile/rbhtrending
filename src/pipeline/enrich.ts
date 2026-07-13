import type { PoolActivity, Security, SecurityConfig, TokenCard } from '../types';
import type { GeckoTokenInfo } from '../sources/geckoterminal';
import { scoreSecurity, type SecurityFields } from '../checks/security';

/**
 * Enrichment sources that flesh out a TokenCard beyond the base activity fields.
 * `securityScan` is required — it's always the reason enrich exists — but its real
 * on-chain implementation lands in a later task; here it's purely injected so the
 * orchestration (parallel fan-out, best-effort degrade-to-'unknown') can be tested
 * without any network/RPC dependency. `tokenInfo` is optional because not every caller has
 * a source for socials/logo/trust-score/top-10 concentration — GeckoTerminal's
 * /tokens/{addr}/info endpoint (src/sources/geckoterminal.ts's GeckoTerminal.tokenInfo).
 */
export interface EnrichDeps {
  securityScan: (tokenAddress: string, poolAddress: string) => Promise<Security | 'unknown'>;
  tokenInfo?: (address: string) => Promise<GeckoTokenInfo>;
}

const UNKNOWN_SECURITY: Security = {
  sellTaxPct: 'unknown',
  topHolderPct: 'unknown',
  riskLevel: 'unknown',
  transferable: 'unknown',
};

/** Fills any absent optional sub-check with the literal 'unknown' so scoreSecurity's degrade
 * rules apply correctly when recomputing riskLevel below — a missing sub-check must never be
 * silently treated as "known-good" just because the property wasn't set. */
function toSecurityFields(s: Security): SecurityFields {
  return {
    honeypot: s.honeypot ?? 'unknown',
    buyTaxPct: s.buyTaxPct ?? 'unknown',
    sellTaxPct: s.sellTaxPct,
    ownerRenounced: s.ownerRenounced ?? 'unknown',
    lpBurnedOrLocked: s.lpBurnedOrLocked ?? 'unknown',
    verified: s.verified ?? 'unknown',
    transferable: s.transferable ?? 'unknown',
    topHolderPct: s.topHolderPct,
  };
}

/**
 * Assembles a TokenCard for a trending pool. Base fields (symbol/name/MC/liq/vol/price)
 * come straight from the already-fetched PoolActivity. Everything else — security verdict
 * and GeckoTerminal token info (socials, logo, trust score, top-10 concentration) — is
 * fetched from the injected deps IN PARALLEL (Promise.all): each source is best-effort and
 * degrades independently to 'unknown' (or is simply omitted) on rejection, so one
 * slow/failing source never blocks or fails the whole card.
 *
 * GeckoTerminal's top-10 holder concentration folds INTO the security verdict rather than
 * just being a display field: a clean on-chain scan (transferable/LP/owner/verified all
 * fine) can still be a rug if most of the supply sits in a handful of wallets, so once
 * `info.topHolderPct` is known, `security.topHolderPct` is updated and `security.riskLevel`
 * is recomputed via the same `scoreSecurity` the on-chain scan itself uses.
 */
export async function enrich(activity: PoolActivity, deps: EnrichDeps, securityCfg: SecurityConfig): Promise<TokenCard> {
  const [scannedSecurity, info] = await Promise.all([
    runSecurityScan(activity, deps),
    runTokenInfo(activity, deps),
  ]);

  let security = scannedSecurity;
  if (typeof info.topHolderPct === 'number') {
    const withConcentration = { ...security, topHolderPct: info.topHolderPct };
    security = { ...withConcentration, riskLevel: scoreSecurity(toSecurityFields(withConcentration), securityCfg) };
  }

  return {
    address: activity.address,
    symbol: activity.symbol,
    name: activity.name,
    liquidityUsd: activity.liquidityUsd,
    volume1hUsd: activity.volume1hUsd,
    buyers1h: activity.buyers1h,
    priceUsd: activity.priceUsd,
    fdvUsd: activity.fdvUsd,
    poolAddress: activity.poolAddress,
    createdAt: activity.createdAt,
    holders: 'unknown',
    // Prefer the /info image; fall back to the free `?include=base_token` image (Task 13 Part A)
    // so every posted card gets a logo even when /info was rate-limited/never cached.
    imageUrl: info.imageUrl ?? activity.imageUrl,
    twitter: info.twitter,
    telegram: info.telegram,
    website: info.website,
    gtScore: info.gtScore,
    security,
  };
}

async function runSecurityScan(activity: PoolActivity, deps: EnrichDeps): Promise<Security> {
  try {
    const result = await deps.securityScan(activity.address, activity.poolAddress);
    return result === 'unknown' ? UNKNOWN_SECURITY : result;
  } catch {
    return UNKNOWN_SECURITY;
  }
}

async function runTokenInfo(activity: PoolActivity, deps: EnrichDeps): Promise<GeckoTokenInfo> {
  if (!deps.tokenInfo) return {};
  try {
    return await deps.tokenInfo(activity.address);
  } catch {
    return {};
  }
}
