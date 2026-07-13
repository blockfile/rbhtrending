import type { PoolActivity, Security, TokenCard } from '../types';

/**
 * Enrichment sources that flesh out a TokenCard beyond the base activity fields.
 * `securityScan` is required — it's always the reason enrich exists — but its real
 * on-chain implementation lands in a later task; here it's purely injected so the
 * orchestration (parallel fan-out, best-effort degrade-to-'unknown') can be tested
 * without any network/RPC dependency. `tokenInfo` is optional because not every
 * caller has a source for holders/ATH/socials yet.
 */
export interface EnrichDeps {
  securityScan: (tokenAddress: string, poolAddress: string) => Promise<Security | 'unknown'>;
  tokenInfo?: (address: string) => Promise<Partial<TokenCard>>;
}

const UNKNOWN_SECURITY: Security = {
  sellTaxPct: 'unknown',
  topHolderPct: 'unknown',
  riskLevel: 'unknown',
};

/**
 * Assembles a TokenCard for a trending pool. Base fields (symbol/name/MC/liq/vol/price)
 * come straight from the already-fetched PoolActivity. Everything else — security verdict,
 * holders, and whatever else a tokenInfo source supplies — is fetched from the injected
 * deps IN PARALLEL (Promise.all): each source is best-effort and degrades independently to
 * 'unknown' (or is simply omitted) on rejection, so one slow/failing source never blocks or
 * fails the whole card.
 */
export async function enrich(activity: PoolActivity, deps: EnrichDeps): Promise<TokenCard> {
  const [security, info] = await Promise.all([
    runSecurityScan(activity, deps),
    runTokenInfo(activity, deps),
  ]);

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
    ...info,
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

async function runTokenInfo(activity: PoolActivity, deps: EnrichDeps): Promise<Partial<TokenCard>> {
  if (!deps.tokenInfo) return {};
  try {
    return await deps.tokenInfo(activity.address);
  } catch {
    return {};
  }
}
