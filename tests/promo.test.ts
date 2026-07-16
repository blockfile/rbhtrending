import { describe, it, expect } from 'vitest';
import { tierRange, priceToWei, formatEth, assignRank, slotsLeft } from '../src/promo/slots';
import { matchByBalance, PaymentWatcher } from '../src/promo/payments';
import { formatLeaderboard, rankOrganic } from '../src/promo/leaderboard';
import { Db } from '../src/db/index';
import type { GmgnToken, PromoConfig, TrendingConfig } from '../src/types';

const PROMO: PromoConfig = {
  enabled: true,
  treasuryAddress: '0xPAY0000000000000000000000000000000000AA'.toLowerCase(),
  confirmations: 3,
  leaderboardSize: 12,
  pendingMinutes: 60,
  adminChatIds: [],
  tiers: {
    top3: { maxRank: 3, slots: 3, bumpMinutes: 30, prices: { '3': 0.1, '6': 0.18, '24': 0.6 } },
    top8: { maxRank: 8, slots: 5, bumpMinutes: 60, prices: { '3': 0.08, '6': 0.14, '24': 0.45 } },
    top12: { maxRank: 12, slots: 4, bumpMinutes: 90, prices: { '3': 0.06, '6': 0.1, '24': 0.35 } },
  },
};

describe('slots', () => {
  it('derives each tier rank range from the previous tier maxRank', () => {
    expect(tierRange(PROMO.tiers, 'top3')).toEqual({ from: 1, to: 3 });
    expect(tierRange(PROMO.tiers, 'top8')).toEqual({ from: 4, to: 8 });
    expect(tierRange(PROMO.tiers, 'top12')).toEqual({ from: 9, to: 12 });
  });

  it('quotes the clean tier price in wei (one deposit address per order — no dust needed)', () => {
    // 0.10 ETH = 1e17 wei exactly
    expect(priceToWei(0.1)).toBe('100000000000000000');
    expect(priceToWei(0.18)).toBe('180000000000000000');
    expect(priceToWei(0.6)).toBe('600000000000000000');
  });

  it('formats wei back to a trimmed ETH string for display', () => {
    expect(formatEth('180000000000000000')).toBe('0.18');
    expect(formatEth('600000000000000000')).toBe('0.6');
    expect(formatEth('1000000000000000000')).toBe('1');
  });

  it('assigns the lowest free rank inside the tier range, or null when full', () => {
    expect(assignRank(PROMO.tiers, 'top3', [])).toBe(1);
    expect(assignRank(PROMO.tiers, 'top3', [1])).toBe(2);
    expect(assignRank(PROMO.tiers, 'top3', [1, 2, 3])).toBeNull();
    expect(assignRank(PROMO.tiers, 'top8', [1, 2])).toBe(4);
    expect(assignRank(PROMO.tiers, 'top12', [9, 11])).toBe(10);
  });

  it('slotsLeft subtracts open orders from tier inventory, floored at 0', () => {
    expect(slotsLeft(PROMO, 'top3', 0)).toBe(3);
    expect(slotsLeft(PROMO, 'top3', 2)).toBe(1);
    expect(slotsLeft(PROMO, 'top3', 5)).toBe(0);
  });
});

describe('matchByBalance', () => {
  const order = (id: number, amountWei: string, depositAddress: string) => ({
    id, chatId: 1, address: '0xCA', symbol: 'HOOD', tier: 'top3', hours: 6, amountWei,
    depositAddress, derivIndex: id, status: 'pending' as const, createdAt: 0, paidAt: null,
    txHash: null, rank: null, expiresAt: null, sweepTx: null, comp: 0, lastBumpedAt: null, bumpMsgId: null,
  });

  it('marks an order paid once its deposit address balance reaches the quoted amount', () => {
    const matches = matchByBalance([order(1, '100', '0xdep1')], { '0xdep1': 100n });
    expect(matches).toEqual([{ orderId: 1, depositAddress: '0xdep1' }]);
  });

  it('accepts an overpayment (balance greater than the quote)', () => {
    expect(matchByBalance([order(1, '100', '0xdep1')], { '0xdep1': 150n })).toHaveLength(1);
  });

  it('ignores underpayment and zero balance', () => {
    expect(matchByBalance([order(1, '100', '0xdep1')], { '0xdep1': 99n })).toEqual([]);
    expect(matchByBalance([order(1, '100', '0xdep1')], { '0xdep1': 0n })).toEqual([]);
  });

  it('matches each pending order against its own address', () => {
    const matches = matchByBalance(
      [order(1, '100', '0xdep1'), order(2, '200', '0xdep2')],
      { '0xdep1': 100n, '0xdep2': 50n },
    );
    expect(matches).toEqual([{ orderId: 1, depositAddress: '0xdep1' }]);
  });
});

describe('PaymentWatcher', () => {
  function rpc(balances: Record<string, bigint>, latest: number) {
    const calls: string[] = [];
    const fetchFn = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const reply = (result: unknown, id: unknown) => ({ jsonrpc: '2.0', id, result });
      const out = Array.isArray(body) ? body.map(handle) : handle(body);
      return { ok: true, json: async () => out } as Response;

      function handle(req: any): unknown {
        calls.push(req.method);
        if (req.method === 'eth_blockNumber') return reply('0x' + latest.toString(16), req.id);
        // eth_getBalance(address, blockTag)
        const addr = String(req.params[0]).toLowerCase();
        return reply('0x' + (balances[addr] ?? 0n).toString(16), req.id);
      }
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }

  it('polls each pending order deposit balance at the confirmed block and returns funded ones', async () => {
    const db = new Db(':memory:');
    const id = db.createOrder({ chatId: 7, address: '0xCA', symbol: 'HOOD', tier: 'top3', hours: 6, amountWei: '1000', depositAddress: '0xdep1', derivIndex: 0, now: 0 });
    const { fetchFn, calls } = rpc({ '0xdep1': 1000n }, 13);
    const w = new PaymentWatcher('https://rpc.example', PROMO, db, fetchFn);

    const matches = await w.tick();
    expect(matches).toEqual([{ orderId: id, depositAddress: '0xdep1' }]);
    // balance queried against block latest-confirmations = 10
    expect(calls).toContain('eth_getBalance');
    db.close();
  });

  it('makes no balance calls when there are no pending orders', async () => {
    const db = new Db(':memory:');
    const { fetchFn, calls } = rpc({}, 50);
    const w = new PaymentWatcher('https://rpc.example', PROMO, db, fetchFn);
    expect(await w.tick()).toEqual([]);
    expect(calls).toEqual(['eth_blockNumber']);
    db.close();
  });
});

describe('rankOrganic', () => {
  const TRENDING: TrendingConfig = {
    minLiquidityUsd: 5000, minVolume1hUsd: 10000, minBuyers1h: 30, pollSeconds: 45,
    milestones: [2], dumpDrawdownPct: 50, maxPostsPerCycle: 10, minMcOfAthPct: 20, minMcOfAthAgeHours: 24,
  };
  const NOW = 1_760_000_000_000;
  const HOUR = 3_600_000;

  // a clean, gate-passing, safe-grade token
  const gt = (over: Partial<GmgnToken> = {}): GmgnToken => ({
    address: '0xA', name: 'n', symbol: 'AAA', priceUsd: 1, priceChange1hPct: 0, volumeUsd: 50000,
    liquidityUsd: 20000, marketCapUsd: 100000, athMarketCapUsd: 100000, swaps: 100, buys: 100, sells: 10,
    holderCount: 300, top10Pct: 18, createdAt: NOW - 2 * HOUR, twitter: undefined, telegram: undefined,
    website: undefined, honeypot: false, buyTaxPct: 0, sellTaxPct: 0, renounced: true, verified: true,
    lpLockedPct: 95, devHoldPct: 0, rugRatioPct: 0, burnPct: 0, smartMoneyCount: 0, kolCount: 0,
    sniperCount: 0, bundlerRatePct: 0, entrapmentPct: 20, ratTraderPct: 0, botDegenPct: 15,
    washTrading: false, hotLevel: 0, ...over,
  });
  const syms = (list: GmgnToken[]) => list.map((t) => t.symbol);

  it('drops honeypots and below-gate (thin liquidity) tokens', () => {
    const out = rankOrganic([
      gt({ symbol: 'HP', honeypot: true }),
      gt({ symbol: 'THIN', liquidityUsd: 100, volumeUsd: 0, buys: 0 }),
      gt({ symbol: 'OK' }),
    ], TRENDING, NOW);
    expect(syms(out)).toEqual(['OK']);
  });

  it('drops old dead-bounce corpses (far below ATH)', () => {
    const out = rankOrganic([
      gt({ symbol: 'DEAD', athMarketCapUsd: 1_000_000, marketCapUsd: 20_000, createdAt: NOW - 5 * 24 * HOUR }),
      gt({ symbol: 'LIVE' }),
    ], TRENDING, NOW);
    expect(syms(out)).toEqual(['LIVE']);
  });

  it('drops danger-grade tokens even when they pass the activity gate', () => {
    const danger = gt({ symbol: 'RUG', top10Pct: 90, devHoldPct: 52 }); // score 38 → danger
    const out = rankOrganic([danger, gt({ symbol: 'SAFE' })], TRENDING, NOW);
    expect(syms(out)).toEqual(['SAFE']);
  });

  it('sorts survivors by assess() score, highest first', () => {
    const hi = gt({ symbol: 'HI' }); // clean → 88
    const lo = gt({ symbol: 'LO', devHoldPct: 40 }); // -20 → 68 (warn, not danger)
    expect(syms(rankOrganic([lo, hi], TRENDING, NOW))).toEqual(['HI', 'LO']);
  });

  it('is a stable sort — equal scores keep the incoming GMGN order', () => {
    const a = gt({ symbol: 'FIRST', address: '0x1' });
    const b = gt({ symbol: 'SECOND', address: '0x2' });
    expect(syms(rankOrganic([a, b], TRENDING, NOW))).toEqual(['FIRST', 'SECOND']);
  });

  it('returns whole GmgnTokens (not just symbols)', () => {
    const out = rankOrganic([gt({ symbol: 'OK', address: '0xABC' })], TRENDING, NOW);
    expect(out[0].address).toBe('0xABC');
  });
});

describe('formatLeaderboard', () => {
  const t = (symbol: string, address: string, mc: number): GmgnToken =>
    ({ symbol, address, marketCapUsd: mc } as GmgnToken);
  const paid = (rank: number, symbol: string, address: string) => ({
    id: rank, chatId: 1, address, symbol, tier: 'top3', hours: 6, amountWei: '1',
    depositAddress: '0xdep', derivIndex: rank, status: 'active' as const, createdAt: 0,
    paidAt: 0, txHash: '0xT', rank, expiresAt: 99, sweepTx: null, comp: 0, lastBumpedAt: null, bumpMsgId: null,
  });

  it('places ⭐ paid slots at their ranks and fills the rest organically, skipping paid addresses', () => {
    const text = formatLeaderboard(
      [paid(2, 'PAID', '0xPAID')],
      [t('AAA', '0xA', 1_200_000), t('PAID', '0xPAID', 500_000), t('BBB', '0xB', 90_000)],
      4,
      'robintrenchbot',
    );
    const lines = text.split('\n');
    expect(lines[0]).toContain('ROBINHOOD TRENDING');
    expect(text).toContain('1. <a href="https://gmgn.ai/robinhood/token/0xA">$AAA</a> · $1.2M');
    expect(text).toContain('2. ⭐ <a href="https://gmgn.ai/robinhood/token/0xPAID">$PAID</a> · $500.0k');
    expect(text).toContain('3. <a href="https://gmgn.ai/robinhood/token/0xB">$BBB</a> · $90.0k');
    expect(text).not.toContain('4.'); // only 3 rows available for 4 slots — no empty row
    expect(text).toContain('⭐ = promoted');
    expect(text).toContain('https://t.me/robintrenchbot?start=trend');
  });

  it('escapes HTML in symbols', () => {
    const text = formatLeaderboard([], [t('A<B>', '0xA', 1000)], 1, 'bot');
    expect(text).toContain('$A&lt;B&gt;');
  });
});

describe('computeSweepValue', () => {
  it('leaves a gas buffer: value = balance - gasLimit*gasPrice*bufferX', async () => {
    const { computeSweepValue } = await import('../src/promo/sweep');
    // balance 1e18, gasLimit 21000, gasPrice 2 gwei, buffer 2 → gasCost = 21000*2e9*2 = 8.4e13
    expect(computeSweepValue(1_000_000_000_000_000_000n, 21000n, 2_000_000_000n, 2)).toBe(
      1_000_000_000_000_000_000n - 84_000_000_000_000n,
    );
  });

  it('returns null when the balance cannot even cover gas (dust)', async () => {
    const { computeSweepValue } = await import('../src/promo/sweep');
    expect(computeSweepValue(1000n, 21000n, 2_000_000_000n, 2)).toBeNull();
  });
});
