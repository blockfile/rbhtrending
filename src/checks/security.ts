import type { Security, SecurityConfig } from '../types';
import { SELECTORS, padAddress, encodeCall, encodeUint, decodeAddress, decodeUint } from '../chain/abi';
import { DEAD_ADDRESSES, DEAD_ADDRESS } from '../chain/constants';

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
  transferable: boolean | 'unknown';
  topHolderPct: number | 'unknown';
}

/**
 * Grades a set of security fields into a single verdict. Pure — no I/O.
 *
 * v1 Option-A: this chain has no standard router, so there is no sell simulation — honeypot,
 * buyTaxPct, and sellTaxPct are permanently 'unknown' out of `securityScan` and are NOT scored
 * here at all (deferred to v1.1). Their place is taken by `transferable`, a self-transfer probe
 * against a real holder: a revert is a hard "this token can't be moved" signal.
 *
 * Two fields are "critical" — they gate existential risks (can't move the token at all / LP can
 * be pulled) — so an 'unknown' on either caps the verdict at 'warn': `transferable` and
 * `lpBurnedOrLocked`. `ownerRenounced` and `verified` are softer signals that only escalate to
 * 'warn' when they're explicitly known-bad (`=== false`); their own 'unknown' is neutral and
 * does NOT warn, to avoid over-warning on ordinary RPC/Blockscout flakiness. `topHolderPct`
 * only escalates when it's a known number above the configured bar.
 */
export function scoreSecurity(s: SecurityFields, cfg: SecurityConfig): 'safe' | 'warn' | 'danger' | 'unknown' {
  if (s.transferable === false || s.lpBurnedOrLocked === false) return 'danger';

  if (
    s.transferable === 'unknown' ||
    s.lpBurnedOrLocked === 'unknown' ||
    s.ownerRenounced === false ||
    s.verified === false ||
    (typeof s.topHolderPct === 'number' && s.topHolderPct > cfg.topHolderWarnPct)
  ) {
    return 'warn';
  }

  return 'safe';
}

/** Minimal on-chain + Blockscout dependencies `securityScan` needs. Stubbed in tests. */
export interface SecurityDeps {
  call(to: string, data: string, from?: string): Promise<string>;
  isVerified(addr: string): Promise<boolean | 'unknown'>;
  /** Recent Transfer-event `to` addresses for the token, newest-first (best-effort candidate
   * list for the transferability probe). Real impl (eth_getLogs) lands in Task 10. */
  recentHolders(token: string): Promise<string[]>;
}

/**
 * Best-effort on-chain security scan: owner-renounce, honeypot + sell-tax simulation (always
 * 'unknown' — see checkHoneypotAndTax), LP-burned check, Blockscout verification, and the v1
 * Option-A transferability probe. Every sub-check degrades to 'unknown' independently — this
 * function itself never throws, no matter how badly the RPC behaves.
 */
export async function securityScan(
  deps: SecurityDeps,
  tokenAddr: string,
  poolAddr: string,
  cfg: SecurityConfig,
): Promise<Security> {
  const [ownerRenounced, honeypotTax, lpBurnedOrLocked, verified, transferable] = await Promise.all([
    checkOwnerRenounced(deps, tokenAddr),
    checkHoneypotAndTax(deps, tokenAddr, poolAddr),
    checkLpBurned(deps, poolAddr),
    checkVerified(deps, tokenAddr),
    checkTransferable(deps, tokenAddr, poolAddr, cfg),
  ]);

  const fields: SecurityFields = {
    honeypot: honeypotTax.honeypot,
    buyTaxPct: 'unknown', // no buy-side simulation is specified for this scan (sell-only)
    sellTaxPct: honeypotTax.sellTaxPct,
    ownerRenounced,
    lpBurnedOrLocked,
    verified,
    transferable,
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
 * to verify and no swap call to simulate a sell through, so this always degrades to 'unknown'
 * rather than trusting a nonexistent contract. FINAL v1 decision (Option-A, Task 6c): honeypot
 * and buy/sell tax are permanently 'unknown' in v1 and no longer affect `scoreSecurity` at all
 * — `checkTransferable` below is the v1 substitute existential-risk check. A real sell-tax
 * simulation is deferred to v1.1.
 */
async function checkHoneypotAndTax(_deps: SecurityDeps, _tokenAddr: string, _poolAddr: string): Promise<HoneypotTaxResult> {
  return { honeypot: 'unknown', sellTaxPct: 'unknown' };
}

/** Cap on how many candidate holders `checkTransferable` will probe before giving up. */
const TRANSFERABLE_MAX_CANDIDATES = 5;

/**
 * v1 Option-A transferability probe (Task 6c): with no router to simulate a sell through,
 * this impersonates a real recent holder and eth_calls a self-send of a tiny fixed amount
 * (1 base unit — never trips an anti-whale max-tx limit on a legit token) to DEAD_ADDRESS. No
 * allowance is needed — `h` already owns the tokens — so a decoded on-chain revert here means
 * the token can't be moved even by its own holder, a hard honeypot signal that doesn't depend
 * on a router existing.
 *
 * Critical distinction (this is what keeps a flaky RPC from falsely stamping a healthy token
 * 🧨 DANGER): only a DECODED REVERT or an explicit false-return is a definitive "not
 * transferable" signal. A thrown TRANSPORT error (timeout, HTTP 500, rate-limit, network) says
 * nothing about the token itself, so it must never resolve to `false` — the loop just moves on
 * to the next candidate holder instead of concluding anything. Best-effort: degrades to
 * 'unknown' whenever the candidate list is empty, every candidate has a zero balance, or every
 * attempt hits a transport error (no definitive success/revert) — it NEVER throws.
 */
async function checkTransferable(
  deps: SecurityDeps,
  tokenAddr: string,
  poolAddr: string,
  _cfg: SecurityConfig,
): Promise<boolean | 'unknown'> {
  try {
    const skip = new Set([...DEAD_ADDRESSES, poolAddr.toLowerCase()]);
    const holders = await deps.recentHolders(tokenAddr);
    const candidates = holders.filter((h) => !skip.has(h.toLowerCase())).slice(0, TRANSFERABLE_MAX_CANDIDATES);

    for (const h of candidates) {
      let bal: bigint;
      try {
        bal = decodeUint(await deps.call(tokenAddr, encodeCall(SELECTORS.balanceOf, padAddress(h))));
      } catch {
        continue; // can't confirm this candidate actually holds tokens — try the next one
      }
      if (bal === 0n) continue;

      const amt = 1n; // tiny fixed probe amount — never trips a max-tx / anti-whale revert
      const data = encodeCall(SELECTORS.transfer, padAddress(DEAD_ADDRESS), encodeUint(amt));
      try {
        const ret = await deps.call(tokenAddr, data, h);
        const clean = (ret || '0x').replace(/^0x/, '');
        // Empty return data (legacy ERC-20s that don't return a bool) or an explicit true-word
        // both prove the token actually moved for a real holder — definitive "transferable".
        if (clean === '' || decodeUint(ret) === 1n) return true;
        // An explicit false-word: the transfer ran but reported failure — definitive "blocked".
        if (decodeUint(ret) === 0n) return false;
        // Any other decoded value isn't a clean boolean signal — inconclusive, try next holder.
        continue;
      } catch (e) {
        // A real decoded on-chain revert is a hard "transfers are blocked" honeypot signal.
        if (/execution reverted|revert/i.test((e as Error).message)) return false;
        // Anything else is a transport failure — it says nothing about the token, so we must
        // NOT conclude false and falsely DANGER a healthy token. Try the next candidate.
        continue;
      }
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
