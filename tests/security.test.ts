import { describe, it, expect } from 'vitest';
import {
  scoreSecurity,
  securityScan,
  type SecurityFields,
  type SecurityDeps,
} from '../src/checks/security';
import { SELECTORS, padAddress, encodeUint, encodeCall } from '../src/chain/abi';
import { ZERO_ADDRESS, DEAD_ADDRESS } from '../src/chain/constants';
import type { SecurityConfig } from '../src/types';

const CFG: SecurityConfig = { sellTaxDangerPct: 30, sellTaxWarnPct: 10, topHolderWarnPct: 25 };

const CLEAN: SecurityFields = {
  honeypot: false,
  buyTaxPct: 2,
  sellTaxPct: 2,
  ownerRenounced: true,
  lpBurnedOrLocked: true,
  verified: true,
  topHolderPct: 5,
};

const ALL_UNKNOWN: SecurityFields = {
  honeypot: 'unknown',
  buyTaxPct: 'unknown',
  sellTaxPct: 'unknown',
  ownerRenounced: 'unknown',
  lpBurnedOrLocked: 'unknown',
  verified: 'unknown',
  topHolderPct: 'unknown',
};

describe('scoreSecurity (pure)', () => {
  it('flags a honeypot as danger', () => {
    expect(scoreSecurity({ ...CLEAN, honeypot: true }, CFG)).toBe('danger');
  });

  it('flags sell tax above the danger threshold as danger', () => {
    expect(scoreSecurity({ ...CLEAN, sellTaxPct: 35 }, CFG)).toBe('danger');
  });

  it('flags LP not burned/locked as danger', () => {
    expect(scoreSecurity({ ...CLEAN, lpBurnedOrLocked: false }, CFG)).toBe('danger');
  });

  it('danger takes priority even when other fields are unknown', () => {
    expect(scoreSecurity({ ...ALL_UNKNOWN, honeypot: true }, CFG)).toBe('danger');
  });

  it('flags sell tax in the warn band as warn', () => {
    // warnPct=10, dangerPct=30 -> 15 is in [warn, danger)
    expect(scoreSecurity({ ...CLEAN, sellTaxPct: 15 }, CFG)).toBe('warn');
  });

  it('flags an un-renounced owner as warn', () => {
    expect(scoreSecurity({ ...CLEAN, ownerRenounced: false }, CFG)).toBe('warn');
  });

  it('flags a top holder above the warn threshold as warn', () => {
    expect(scoreSecurity({ ...CLEAN, topHolderPct: 30 }, CFG)).toBe('warn');
  });

  it('never returns safe when honeypot is unknown', () => {
    const result = scoreSecurity({ ...CLEAN, honeypot: 'unknown' }, CFG);
    expect(result).not.toBe('safe');
    expect(result).toBe('warn');
  });

  it('never returns safe when lpBurnedOrLocked is unknown', () => {
    const result = scoreSecurity({ ...CLEAN, lpBurnedOrLocked: 'unknown' }, CFG);
    expect(result).not.toBe('safe');
    expect(result).toBe('warn');
  });

  it('stays safe when only topHolderPct is unknown (not a critical field)', () => {
    // securityScan always leaves topHolderPct 'unknown' (GeckoTerminal supplies it later) —
    // 'safe' must still be reachable as long as the existential-risk fields are known-clean.
    expect(scoreSecurity({ ...CLEAN, topHolderPct: 'unknown' }, CFG)).toBe('safe');
  });

  it('returns safe when every field is known and clean', () => {
    expect(scoreSecurity(CLEAN, CFG)).toBe('safe');
  });

  it('returns unknown when every field is unknown (total blackout)', () => {
    expect(scoreSecurity(ALL_UNKNOWN, CFG)).toBe('unknown');
  });
});

// --- securityScan -----------------------------------------------------------------------

const TOKEN = '0x' + '1'.repeat(39) + 'a';
const POOL = '0x' + '2'.repeat(39) + 'b';
const QUOTE = '0x' + '3'.repeat(39) + 'c';

function amountsReturn(amountIn: bigint, amountOut: bigint): string {
  // uint256[] amounts: offset(0x20) + length(2) + amountIn + amountOut
  return '0x' + encodeUint(32n) + encodeUint(2n) + encodeUint(amountIn) + encodeUint(amountOut);
}

type CallStub = (to: string, data: string, from?: string) => Promise<string>;

/**
 * A fully-healthy set of stubbed on-chain responses; tests override individual calls via
 * (in order of specificity): exact `to:data` (needed when two calls share a selector but
 * differ by argument, e.g. balanceOf(dead1) vs balanceOf(dead2)), `to:selector`, or bare
 * `selector` (matches regardless of `to`).
 */
function healthyCall(overrides: Partial<Record<string, CallStub>> = {}): CallStub {
  return async (to: string, data: string, from?: string) => {
    const sel = data.slice(0, 10);
    const exactKey = `${to.toLowerCase()}:${data.toLowerCase()}`;
    const selKey = `${to.toLowerCase()}:${sel}`;
    if (overrides[exactKey]) return overrides[exactKey]!(to, data, from);
    if (overrides[selKey]) return overrides[selKey]!(to, data, from);
    if (overrides[sel]) return overrides[sel]!(to, data, from);

    if (to === TOKEN && sel === SELECTORS.owner) return padAddress(ZERO_ADDRESS);
    if (to === POOL && sel === SELECTORS.token0) return padAddress(TOKEN);
    if (to === POOL && sel === SELECTORS.token1) return padAddress(QUOTE);
    if (to === POOL && sel === SELECTORS.totalSupply) return '0x' + encodeUint(1000n);
    if (to === POOL && sel === SELECTORS.balanceOf) return '0x' + encodeUint(0n);
    throw new Error(`unstubbed call: ${to} ${sel}`);
  };
}

function makeDeps(overrides: Partial<Record<string, CallStub>> = {}, isVerified: SecurityDeps['isVerified'] = async () => true): SecurityDeps {
  return { call: healthyCall(overrides), isVerified };
}

describe('securityScan (stubbed deps, no network)', () => {
  it('marks the owner renounced when owner() resolves to the zero address', async () => {
    const result = await securityScan(makeDeps(), TOKEN, POOL, CFG);
    expect(result.ownerRenounced).toBe(true);
  });

  it('treats owner() reverting as renounced (no owner() = already renounced/never had one)', async () => {
    const deps = makeDeps({
      [`${TOKEN.toLowerCase()}:${SELECTORS.owner}`]: async () => { throw new Error('revert'); },
    });
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    expect(result.ownerRenounced).toBe(true);
  });

  it('degrades honeypot/tax to unknown (not true) — this chain has no router to simulate a sell through', async () => {
    // Live-verified: Robinhood Chain has no standard router (the old ROUTER_ADDRESS constant
    // was wrong and has been deleted — see src/chain/constants.ts). Without a router there's
    // no getAmountsOut/swapExactTokensForTokens to call, so honeypot/tax always degrade to
    // 'unknown' rather than trusting a nonexistent contract (Task 6c will replace this sim).
    const result = await securityScan(makeDeps(), TOKEN, POOL, CFG);
    expect(result.honeypot).toBe('unknown');
    expect(result.sellTaxPct).toBe('unknown');
    expect(result.riskLevel).not.toBe('danger');
    expect(result.riskLevel).toBe('warn');
  });

  function balanceOfCalldata(holder: string): string {
    return encodeCall(SELECTORS.balanceOf, padAddress(holder));
  }

  it('flags LP burned when the dead-address balance is >=99% of total supply', async () => {
    const deps = makeDeps({
      [`${POOL.toLowerCase()}:${SELECTORS.totalSupply}`]: async () => '0x' + encodeUint(1000n),
      [`${POOL.toLowerCase()}:${balanceOfCalldata(ZERO_ADDRESS)}`]: async () => '0x' + encodeUint(990n),
      [`${POOL.toLowerCase()}:${balanceOfCalldata(DEAD_ADDRESS)}`]: async () => '0x' + encodeUint(0n),
    });
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    expect(result.lpBurnedOrLocked).toBe(true);
  });

  it('leaves LP status unknown when burned balance is below the ~99% bar', async () => {
    const deps = makeDeps({
      [`${POOL.toLowerCase()}:${SELECTORS.totalSupply}`]: async () => '0x' + encodeUint(1000n),
      [`${POOL.toLowerCase()}:${balanceOfCalldata(ZERO_ADDRESS)}`]: async () => '0x' + encodeUint(500n),
      [`${POOL.toLowerCase()}:${balanceOfCalldata(DEAD_ADDRESS)}`]: async () => '0x' + encodeUint(0n),
    });
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    expect(result.lpBurnedOrLocked).toBe('unknown');
  });

  it('reports the Blockscout verified flag from deps.isVerified', async () => {
    const result = await securityScan(makeDeps({}, async () => false), TOKEN, POOL, CFG);
    expect(result.verified).toBe(false);
  });

  it('leaves topHolderPct unknown (out of scope for this scan)', async () => {
    const result = await securityScan(makeDeps(), TOKEN, POOL, CFG);
    expect(result.topHolderPct).toBe('unknown');
  });

  it('never throws even if every call and isVerified reject, and degrades to an all-unknown-ish Security', async () => {
    const deps: SecurityDeps = {
      call: async () => { throw new Error('network down'); },
      isVerified: async () => { throw new Error('network down'); },
    };
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    // owner() reverting is treated as renounced (documented default); everything else that
    // depends on a live call degrades to 'unknown'.
    expect(result.ownerRenounced).toBe(true);
    expect(result.honeypot).toBe('unknown');
    expect(result.sellTaxPct).toBe('unknown');
    expect(result.lpBurnedOrLocked).toBe('unknown');
    expect(result.verified).toBe('unknown');
    expect(result.topHolderPct).toBe('unknown');
    expect(['warn', 'unknown']).toContain(result.riskLevel);
  });
});
