import type { Security, SecurityConfig } from '../types';
import { SELECTORS, padAddress, encodeCall, decodeAddress, decodeUint } from '../chain/abi';
import { DEAD_ADDRESSES } from '../chain/constants';

/** Minimum burned-or-locked fraction (dead-address balance / total supply) to call LP burned. */
const LP_BURN_BAR_NUM = 99n; // ratio >= 99/100, computed in integer math to avoid float drift
const LP_BURN_BAR_DEN = 100n;

/**
 * The raw on-chain security signals `scoreSecurity` grades. Every field is mandatory (never
 * `undefined`) so a caller can't accidentally drop a field and have it silently misread as
 * "known clean" — every sub-check must explicitly resolve to a real value or the literal
 * 'unknown'.
 */
export interface SecurityFields {
  honeypot: boolean | 'unknown';
  buyTaxPct: number | 'unknown';
  sellTaxPct: number | 'unknown';
  ownerRenounced: boolean | 'unknown';
  lpBurnedOrLocked: boolean | 'unknown';
  verified: boolean | 'unknown';
  topHolderPct: number | 'unknown';
}

/**
 * Grades a set of security fields into a single verdict. Pure — no I/O. Two fields
 * (honeypot, lpBurnedOrLocked) are "critical": they gate existential risks (can't sell at
 * all / LP can be pulled), so an 'unknown' on either caps the verdict at 'warn'. The
 * softer signals (tax amount, renounce status, holder concentration) only escalate to
 * 'warn' when they're actually known to be bad — their absence alone doesn't block 'safe',
 * because topHolderPct in particular is *always* 'unknown' out of this module (holders come
 * from a GeckoTerminal enrichment stage elsewhere) and a 'safe' tier that can never fire
 * would be useless.
 */
export function scoreSecurity(s: SecurityFields, cfg: SecurityConfig): 'safe' | 'warn' | 'danger' | 'unknown' {
  if (s.honeypot === true) return 'danger';
  if (typeof s.sellTaxPct === 'number' && s.sellTaxPct > cfg.sellTaxDangerPct) return 'danger';
  if (s.lpBurnedOrLocked === false) return 'danger';

  const scored = [s.honeypot, s.sellTaxPct, s.ownerRenounced, s.lpBurnedOrLocked, s.topHolderPct];
  if (scored.every((v) => v === 'unknown')) return 'unknown';

  if (s.honeypot === 'unknown' || s.lpBurnedOrLocked === 'unknown') return 'warn';
  if (typeof s.sellTaxPct === 'number' && s.sellTaxPct >= cfg.sellTaxWarnPct) return 'warn';
  if (s.ownerRenounced === false) return 'warn';
  if (typeof s.topHolderPct === 'number' && s.topHolderPct > cfg.topHolderWarnPct) return 'warn';

  return 'safe';
}

/** Minimal on-chain + Blockscout dependencies `securityScan` needs. Stubbed in tests. */
export interface SecurityDeps {
  call(to: string, data: string, from?: string): Promise<string>;
  isVerified(addr: string): Promise<boolean | 'unknown'>;
}

/**
 * Best-effort on-chain security scan: owner-renounce, honeypot + sell-tax simulation,
 * LP-burned check, and Blockscout verification. Every sub-check degrades to 'unknown'
 * independently — this function itself never throws, no matter how badly the RPC behaves.
 */
export async function securityScan(
  deps: SecurityDeps,
  tokenAddr: string,
  poolAddr: string,
  cfg: SecurityConfig,
): Promise<Security> {
  const [ownerRenounced, honeypotTax, lpBurnedOrLocked, verified] = await Promise.all([
    checkOwnerRenounced(deps, tokenAddr),
    checkHoneypotAndTax(deps, tokenAddr, poolAddr),
    checkLpBurned(deps, poolAddr),
    checkVerified(deps, tokenAddr),
  ]);

  const fields: SecurityFields = {
    honeypot: honeypotTax.honeypot,
    buyTaxPct: 'unknown', // no buy-side simulation is specified for this scan (sell-only)
    sellTaxPct: honeypotTax.sellTaxPct,
    ownerRenounced,
    lpBurnedOrLocked,
    verified,
    topHolderPct: 'unknown', // supplied later by GeckoTerminal enrichment, not this module
  };

  return { ...fields, riskLevel: scoreSecurity(fields, cfg) };
}

/** owner() -> DEAD_ADDRESSES means renounced. A revert (no owner() function) is treated as
 * renounced too — that's the common shape of an already-renounced or never-had-an-owner token. */
async function checkOwnerRenounced(deps: SecurityDeps, tokenAddr: string): Promise<boolean | 'unknown'> {
  try {
    const result = await deps.call(tokenAddr, encodeCall(SELECTORS.owner));
    return DEAD_ADDRESSES.has(decodeAddress(result).toLowerCase());
  } catch {
    return true;
  }
}

async function checkVerified(deps: SecurityDeps, tokenAddr: string): Promise<boolean | 'unknown'> {
  try {
    return await deps.isVerified(tokenAddr);
  } catch {
    return 'unknown';
  }
}

/** LP token = the pair itself. Burned if dead-address balance is >=~99% of total supply.
 * Locker-contract detection is out of scope — anything below the bar stays 'unknown', it's
 * never asserted `false` (we simply don't know), which is why 'danger' via this field can
 * only come from a caller constructing SecurityFields directly (e.g. in scoreSecurity's own
 * unit tests), not from this scan. */
async function checkLpBurned(deps: SecurityDeps, poolAddr: string): Promise<boolean | 'unknown'> {
  try {
    const deadAddrs = [...DEAD_ADDRESSES];
    const [totalSupplyHex, ...balanceHexes] = await Promise.all([
      deps.call(poolAddr, encodeCall(SELECTORS.totalSupply)),
      ...deadAddrs.map((addr) => deps.call(poolAddr, encodeCall(SELECTORS.balanceOf, padAddress(addr)))),
    ]);
    const totalSupply = decodeUint(totalSupplyHex);
    if (totalSupply === 0n) return 'unknown';
    const deadBalance = balanceHexes.reduce((sum, hex) => sum + decodeUint(hex), 0n);
    return deadBalance * LP_BURN_BAR_DEN >= totalSupply * LP_BURN_BAR_NUM ? true : 'unknown';
  } catch {
    return 'unknown';
  }
}

interface HoneypotTaxResult {
  honeypot: boolean | 'unknown';
  sellTaxPct: number | 'unknown';
}

/**
 * Robinhood Chain has NO standard router exposing getAmountsOut/swapExactTokensForTokens
 * (live-verified — see src/chain/constants.ts; the old ROUTER_ADDRESS constant this used to
 * call was wrong and has been deleted). Without a router there is no getAmountsOut round-trip
 * to verify and no swap call to simulate a sell through, so this always degrades to
 * 'unknown' rather than trusting a nonexistent contract. A real sell-simulation (reserve-math
 * quote + real-holder or state-override impersonation) is deferred to Task 6c.
 */
async function checkHoneypotAndTax(_deps: SecurityDeps, _tokenAddr: string, _poolAddr: string): Promise<HoneypotTaxResult> {
  return { honeypot: 'unknown', sellTaxPct: 'unknown' };
}
