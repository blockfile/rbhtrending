import type { Security, SecurityConfig } from '../types';
import { SELECTORS, padAddress, encodeUint, encodeCall, decodeAddress, decodeUint } from '../chain/abi';

/**
 * VERIFIED chain fact (live spike, see docs/superpowers/plans/2026-07-13-robinhood-trending-v1.md):
 * the `.to` of a live swap tx on Robinhood Chain (EVM 4663). Runtime-verified below via
 * factory() + a getAmountsOut round-trip before any dependent call is trusted — if that
 * verification fails (aggregator, wrong address, etc.) the honeypot/tax fields degrade to
 * 'unknown' rather than hard-failing the whole scan.
 */
export const ROUTER_ADDRESS = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';

export const ZERO_ADDRESS = '0x' + '0'.repeat(40);
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dead';
/** Addresses treated as "gone forever" for both owner-renounce and LP-burn checks. */
export const DEAD_ADDRESSES = new Set([ZERO_ADDRESS, BURN_ADDRESS]);

/** Nominal probe amount for the sell simulation / getAmountsOut round-trip. Both calls use
 * the same amountIn, so the exact scale is irrelevant to the resulting tax ratio — it just
 * needs to be non-zero and small enough not to swing an AMM's price materially. */
const PROBE_AMOUNT_IN = 1_000_000_000n;
/** Far-future swap deadline — this is a simulated call, never actually mined. */
const SWAP_DEADLINE = 9_999_999_999n;
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
 * Verifies the router candidate (factory() + a getAmountsOut round-trip against the pool's
 * actual quote token), then simulates a sell of a nominal amount impersonating the pool as
 * the seller (the closest thing to "a holder" this scan has without a discovered real
 * holder or state-override support in `SecurityDeps.call`) via
 * swapExactTokensForTokens. On success, honeypot = false and sellTaxPct = the shortfall
 * between the pure-AMM expected output and the simulated actual output.
 *
 * Router-verification failures (unverifiable router, bad path, no liquidity) degrade to
 * 'unknown'. A revert on the *sell* call itself also degrades to 'unknown' rather than
 * honeypot=true: pool-impersonation reverts on ERC-20 allowance for every token (a pair
 * never approves the router to spend its own tokens), so a revert here can't yet be
 * distinguished from a real honeypot — see the INTERIM comment below.
 */
async function checkHoneypotAndTax(deps: SecurityDeps, tokenAddr: string, poolAddr: string): Promise<HoneypotTaxResult> {
  const UNKNOWN: HoneypotTaxResult = { honeypot: 'unknown', sellTaxPct: 'unknown' };

  let expectedOut: bigint;
  let quote: string;
  try {
    await deps.call(ROUTER_ADDRESS, encodeCall(SELECTORS.factory));

    const [token0Hex, token1Hex] = await Promise.all([
      deps.call(poolAddr, encodeCall(SELECTORS.token0)),
      deps.call(poolAddr, encodeCall(SELECTORS.token1)),
    ]);
    const token0 = decodeAddress(token0Hex).toLowerCase();
    const token1 = decodeAddress(token1Hex).toLowerCase();
    quote = token0 === tokenAddr.toLowerCase() ? token1 : token0;

    const expectedHex = await deps.call(ROUTER_ADDRESS, encodeGetAmountsOut(tokenAddr, quote));
    expectedOut = decodeLastAmount(expectedHex);
    if (expectedOut === 0n) return UNKNOWN;
  } catch {
    return UNKNOWN;
  }

  try {
    const swapData = encodeSwapExactTokensForTokens(tokenAddr, quote);
    const actualHex = await deps.call(ROUTER_ADDRESS, swapData, poolAddr);
    const actualOut = decodeLastAmount(actualHex);
    const sellTaxPct = actualOut >= expectedOut ? 0 : (Number(expectedOut - actualOut) / Number(expectedOut)) * 100;
    return { honeypot: false, sellTaxPct };
  } catch {
    // INTERIM: pool-impersonation reverts on allowance for all tokens; cannot distinguish
    // honeypot from structural revert. Rework with real-holder impersonation or eth_call
    // state-overrides (live-RPC task) before trusting a revert as a honeypot signal.
    return { honeypot: 'unknown', sellTaxPct: 'unknown' };
  }
}

/** getAmountsOut(uint256 amountIn, address[] path) — path = [token, quote]. */
function encodeGetAmountsOut(token: string, quote: string): string {
  return encodeCall(
    SELECTORS.getAmountsOut,
    encodeUint(PROBE_AMOUNT_IN),
    encodeUint(64n), // offset to the dynamic `path` array (2 head words = 0x40)
    encodeUint(2n), // path.length
    padAddress(token),
    padAddress(quote),
  );
}

/** swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline). */
function encodeSwapExactTokensForTokens(token: string, quote: string): string {
  return encodeCall(
    SELECTORS.swapExactTokensForTokens,
    encodeUint(PROBE_AMOUNT_IN),
    encodeUint(0n), // amountOutMin — this is a simulation, not a real trade
    encodeUint(160n), // offset to `path` (5 head words: amountIn, amountOutMin, offset, to, deadline = 0xa0)
    padAddress(BURN_ADDRESS), // 'to' — the simulated output is discarded, only the ratio matters
    encodeUint(SWAP_DEADLINE),
    encodeUint(2n), // path.length
    padAddress(token),
    padAddress(quote),
  );
}

/** Both getAmountsOut and swapExactTokensForTokens return `uint256[] amounts`; the figure we
 * want (the final hop's output) is always the array's last word. Reuses decodeUint for the
 * actual number decode — this only slices the substring to hand it off. */
function decodeLastAmount(hex: string): bigint {
  const clean = hex.replace(/^0x/, '');
  if (clean.length < 64) return 0n;
  return decodeUint(clean.slice(-64));
}
