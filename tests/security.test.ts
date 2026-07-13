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

// v1 Option-A reality: honeypot/buyTaxPct/sellTaxPct are permanently 'unknown' out of
// securityScan (no router to simulate a sell through — see checkHoneypotAndTax). CLEAN
// reflects that: the four fields the v1 badge actually grades (transferable, lpBurnedOrLocked,
// ownerRenounced, verified) are known-good; honeypot/tax stay unmeasured.
const CLEAN: SecurityFields = {
  honeypot: 'unknown',
  buyTaxPct: 'unknown',
  sellTaxPct: 'unknown',
  ownerRenounced: true,
  lpBurnedOrLocked: true,
  verified: true,
  transferable: true,
  topHolderPct: 5,
};

const ALL_UNKNOWN: SecurityFields = {
  honeypot: 'unknown',
  buyTaxPct: 'unknown',
  sellTaxPct: 'unknown',
  ownerRenounced: 'unknown',
  lpBurnedOrLocked: 'unknown',
  verified: 'unknown',
  transferable: 'unknown',
  topHolderPct: 'unknown',
};

describe('scoreSecurity (pure) — v1 Option-A decision table', () => {
  it('flags transferable === false as danger (transfers are blocked — hard honeypot signal)', () => {
    expect(scoreSecurity({ ...CLEAN, transferable: false }, CFG)).toBe('danger');
  });

  it('flags lpBurnedOrLocked === false as danger', () => {
    expect(scoreSecurity({ ...CLEAN, lpBurnedOrLocked: false }, CFG)).toBe('danger');
  });

  it('danger takes priority even when every other field is unknown', () => {
    expect(scoreSecurity({ ...ALL_UNKNOWN, transferable: false }, CFG)).toBe('danger');
    expect(scoreSecurity({ ...ALL_UNKNOWN, lpBurnedOrLocked: false }, CFG)).toBe('danger');
  });

  it('warns when transferable is unknown (critical field — cannot confirm the token is movable)', () => {
    expect(scoreSecurity({ ...CLEAN, transferable: 'unknown' }, CFG)).toBe('warn');
  });

  it('warns when lpBurnedOrLocked is unknown (critical field)', () => {
    expect(scoreSecurity({ ...CLEAN, lpBurnedOrLocked: 'unknown' }, CFG)).toBe('warn');
  });

  it('warns when ownerRenounced is explicitly false', () => {
    expect(scoreSecurity({ ...CLEAN, ownerRenounced: false }, CFG)).toBe('warn');
  });

  it('warns when verified is explicitly false', () => {
    expect(scoreSecurity({ ...CLEAN, verified: false }, CFG)).toBe('warn');
  });

  it('does NOT warn when verified is unknown (neutral — avoids over-warning on Blockscout flakiness)', () => {
    expect(scoreSecurity({ ...CLEAN, verified: 'unknown' }, CFG)).toBe('safe');
  });

  it('does NOT warn when ownerRenounced is unknown (neutral — avoids over-warning on RPC flakiness)', () => {
    expect(scoreSecurity({ ...CLEAN, ownerRenounced: 'unknown' }, CFG)).toBe('safe');
  });

  it('warns when top holder concentration exceeds the configured threshold', () => {
    expect(scoreSecurity({ ...CLEAN, topHolderPct: 30 }, CFG)).toBe('warn');
  });

  it('returns safe when transferable/LP/owner/verified are known-good and top holder is under the bar', () => {
    expect(scoreSecurity(CLEAN, CFG)).toBe('safe');
  });

  it('stays safe when honeypot/tax are unknown — not measured in v1, and must never block safe', () => {
    expect(
      scoreSecurity({ ...CLEAN, honeypot: 'unknown', buyTaxPct: 'unknown', sellTaxPct: 'unknown' }, CFG),
    ).toBe('safe');
  });

  it('ignores sellTaxPct entirely — even a value above the old danger threshold does not affect the v1 score', () => {
    expect(scoreSecurity({ ...CLEAN, sellTaxPct: 99 }, CFG)).toBe('safe');
  });

  it('ignores honeypot === true entirely — v1 never simulates a sell, so honeypot can never escalate the score', () => {
    expect(scoreSecurity({ ...CLEAN, honeypot: true }, CFG)).toBe('safe');
  });

  it('resolves a total blackout to warn (transferable/lp unknown alone forces at least warn), never a bare "safe"', () => {
    expect(scoreSecurity(ALL_UNKNOWN, CFG)).toBe('warn');
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

function makeDeps(
  overrides: Partial<Record<string, CallStub>> = {},
  isVerified: SecurityDeps['isVerified'] = async () => true,
  recentHolders: SecurityDeps['recentHolders'] = async () => [],
): SecurityDeps {
  return { call: healthyCall(overrides), isVerified, recentHolders };
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
    // 'unknown' permanently in v1 — deferred to v1.1, and per Option-A they no longer affect
    // the score at all (see scoreSecurity). The scan still warns here because transferable and
    // lpBurnedOrLocked are 'unknown' with these healthy-but-uninformative stubs.
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

  it('never throws even if every call, isVerified, and recentHolders reject, and degrades to an all-unknown-ish Security', async () => {
    const deps: SecurityDeps = {
      call: async () => { throw new Error('network down'); },
      isVerified: async () => { throw new Error('network down'); },
      recentHolders: async () => { throw new Error('network down'); },
    };
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    // owner() reverting is treated as renounced (documented default); everything else that
    // depends on a live call degrades to 'unknown'.
    expect(result.ownerRenounced).toBe(true);
    expect(result.honeypot).toBe('unknown');
    expect(result.sellTaxPct).toBe('unknown');
    expect(result.lpBurnedOrLocked).toBe('unknown');
    expect(result.verified).toBe('unknown');
    expect(result.transferable).toBe('unknown');
    expect(result.topHolderPct).toBe('unknown');
    expect(result.riskLevel).toBe('warn');
  });
});

// --- checkTransferable (via securityScan.transferable) -----------------------------------

describe('securityScan — transferability probe (Option-A)', () => {
  const HOLDER = '0x' + '4'.repeat(39) + 'd';
  const HOLDER2 = '0x' + '5'.repeat(39) + 'e';

  function balanceOfCalldata(holder: string): string {
    return encodeCall(SELECTORS.balanceOf, padAddress(holder));
  }

  function fundedBalance(holder: string, bal = 1000n): Partial<Record<string, CallStub>> {
    return { [`${TOKEN.toLowerCase()}:${balanceOfCalldata(holder)}`]: async () => '0x' + encodeUint(bal) };
  }

  it('resolves transferable=true when the self-send returns 0x (no return data on success)', async () => {
    const deps = makeDeps(
      {
        ...fundedBalance(HOLDER),
        [`${TOKEN.toLowerCase()}:${SELECTORS.transfer}`]: async () => '0x',
      },
      undefined,
      async () => [HOLDER],
    );
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    expect(result.transferable).toBe(true);
  });

  it('resolves transferable=true when the self-send returns a true-word (1)', async () => {
    const deps = makeDeps(
      {
        ...fundedBalance(HOLDER),
        [`${TOKEN.toLowerCase()}:${SELECTORS.transfer}`]: async () => '0x' + encodeUint(1n),
      },
      undefined,
      async () => [HOLDER],
    );
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    expect(result.transferable).toBe(true);
  });

  it('resolves transferable=false when the self-send returns a false-word (0) — definitively not transferable', async () => {
    const deps = makeDeps(
      {
        ...fundedBalance(HOLDER),
        [`${TOKEN.toLowerCase()}:${SELECTORS.transfer}`]: async () => '0x' + encodeUint(0n),
      },
      undefined,
      async () => [HOLDER],
    );
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    expect(result.transferable).toBe(false);
    expect(result.riskLevel).toBe('danger');
  });

  it('resolves transferable=false when the self-send reverts on-chain (hard honeypot signal) and scores danger', async () => {
    const deps = makeDeps(
      {
        ...fundedBalance(HOLDER),
        [`${TOKEN.toLowerCase()}:${SELECTORS.transfer}`]: async () => {
          throw new Error('execution reverted: TRANSFER_BLOCKED');
        },
      },
      undefined,
      async () => [HOLDER],
    );
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    expect(result.transferable).toBe(false);
    expect(result.riskLevel).toBe('danger');
  });

  it('leaves transferable unknown (NOT false) when the only funded holder hits a transport error — must never falsely DANGER a healthy token', async () => {
    const deps = makeDeps(
      {
        ...fundedBalance(HOLDER),
        [`${TOKEN.toLowerCase()}:${SELECTORS.transfer}`]: async () => {
          throw new Error('RPC HTTP error: 500');
        },
      },
      undefined,
      async () => [HOLDER],
    );
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    expect(result.transferable).toBe('unknown');
    expect(result.riskLevel).not.toBe('danger');
  });

  it('leaves transferable unknown when the only funded holder hits a network transport error (fetch failed)', async () => {
    const deps = makeDeps(
      {
        ...fundedBalance(HOLDER),
        [`${TOKEN.toLowerCase()}:${SELECTORS.transfer}`]: async () => {
          throw new Error('fetch failed');
        },
      },
      undefined,
      async () => [HOLDER],
    );
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    expect(result.transferable).toBe('unknown');
  });

  it('does not stop at the first holder on a transport error — tries the next candidate and resolves true', async () => {
    let transferCalls = 0;
    const deps = makeDeps(
      {
        ...fundedBalance(HOLDER),
        ...fundedBalance(HOLDER2),
        [`${TOKEN.toLowerCase()}:${SELECTORS.transfer}`]: async (_to, _data, from) => {
          transferCalls++;
          if (from?.toLowerCase() === HOLDER.toLowerCase()) throw new Error('RPC HTTP error: 500');
          return '0x' + encodeUint(1n);
        },
      },
      undefined,
      async () => [HOLDER, HOLDER2],
    );
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    expect(result.transferable).toBe(true);
    expect(transferCalls).toBe(2);
  });

  it('probes a tiny fixed amount (1n), not half the holder balance', async () => {
    let capturedData = '';
    const deps = makeDeps(
      {
        ...fundedBalance(HOLDER, 1000n),
        [`${TOKEN.toLowerCase()}:${SELECTORS.transfer}`]: async (_to, data) => {
          capturedData = data;
          return '0x' + encodeUint(1n);
        },
      },
      undefined,
      async () => [HOLDER],
    );
    await securityScan(deps, TOKEN, POOL, CFG);
    expect(capturedData).toBe(encodeCall(SELECTORS.transfer, padAddress(DEAD_ADDRESS), encodeUint(1n)));
  });

  it('leaves transferable unknown when recentHolders resolves an empty list', async () => {
    const deps = makeDeps({}, undefined, async () => []);
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    expect(result.transferable).toBe('unknown');
  });

  it('leaves transferable unknown when every candidate holder has a zero balance', async () => {
    const deps = makeDeps(
      { [`${TOKEN.toLowerCase()}:${balanceOfCalldata(HOLDER)}`]: async () => '0x' + encodeUint(0n) },
      undefined,
      async () => [HOLDER],
    );
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    expect(result.transferable).toBe('unknown');
  });

  it('skips dead addresses and the pool address when picking a candidate holder', async () => {
    const deps = makeDeps(
      {
        [`${TOKEN.toLowerCase()}:${balanceOfCalldata(HOLDER)}`]: async () => '0x' + encodeUint(1000n),
        [`${TOKEN.toLowerCase()}:${SELECTORS.transfer}`]: async () => '0x' + encodeUint(1n),
      },
      undefined,
      async () => [ZERO_ADDRESS, DEAD_ADDRESS, POOL, HOLDER],
    );
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    expect(result.transferable).toBe(true);
  });

  it('caps candidate attempts at the first 5 holders (never reaches a 6th, even one that would succeed)', async () => {
    const zeroHolders = Array.from({ length: 5 }, (_, i) => '0x' + String(i + 1).repeat(39) + 'e');
    const sixthGoodHolder = '0x' + '9'.repeat(39) + 'f';
    const overrides: Partial<Record<string, CallStub>> = {
      [`${TOKEN.toLowerCase()}:${balanceOfCalldata(sixthGoodHolder)}`]: async () => '0x' + encodeUint(1000n),
      [`${TOKEN.toLowerCase()}:${SELECTORS.transfer}`]: async () => '0x' + encodeUint(1n),
    };
    for (const h of zeroHolders) {
      overrides[`${TOKEN.toLowerCase()}:${balanceOfCalldata(h)}`] = async () => '0x' + encodeUint(0n);
    }
    const deps = makeDeps(overrides, undefined, async () => [...zeroHolders, sixthGoodHolder]);
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    // If the cap were missing, the 6th holder's nonzero balance + successful transfer would
    // make this 'true'. Capped at 5 zero-balance candidates, it must stay 'unknown'.
    expect(result.transferable).toBe('unknown');
  });

  it('never throws when recentHolders rejects — degrades to unknown', async () => {
    const deps = makeDeps({}, undefined, async () => { throw new Error('eth_getLogs failed'); });
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    expect(result.transferable).toBe('unknown');
  });

  it('never throws when the balanceOf call rejects for every candidate — degrades to unknown', async () => {
    const deps = makeDeps(
      { [`${TOKEN.toLowerCase()}:${balanceOfCalldata(HOLDER)}`]: async () => { throw new Error('rpc down'); } },
      undefined,
      async () => [HOLDER],
    );
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    expect(result.transferable).toBe('unknown');
  });
});
