import { describe, it, expect } from 'vitest';
import { tierRange, quoteAmountWei, formatEth, assignRank, slotsLeft } from '../src/promo/slots';
import { matchPayments, PaymentWatcher } from '../src/promo/payments';
import { formatLeaderboard } from '../src/promo/leaderboard';
import { Db } from '../src/db/index';
import type { GmgnToken, PromoConfig } from '../src/types';

const PROMO: PromoConfig = {
  enabled: true,
  paymentAddress: '0xPAY0000000000000000000000000000000000AA'.toLowerCase(),
  confirmations: 3,
  leaderboardSize: 12,
  pendingMinutes: 60,
  tiers: {
    top3: { maxRank: 3, slots: 3, prices: { '3': 0.1, '6': 0.18, '24': 0.6 } },
    top8: { maxRank: 8, slots: 5, prices: { '3': 0.08, '6': 0.14, '24': 0.45 } },
    top12: { maxRank: 12, slots: 4, prices: { '3': 0.06, '6': 0.1, '24': 0.35 } },
  },
};

describe('slots', () => {
  it('derives each tier rank range from the previous tier maxRank', () => {
    expect(tierRange(PROMO.tiers, 'top3')).toEqual({ from: 1, to: 3 });
    expect(tierRange(PROMO.tiers, 'top8')).toEqual({ from: 4, to: 8 });
    expect(tierRange(PROMO.tiers, 'top12')).toEqual({ from: 9, to: 12 });
  });

  it('quotes price as wei plus a unique gwei-granularity dust from the rng', () => {
    // 0.10 ETH = 1e17 wei; rng 0 → minimum dust of 1 gwei
    expect(quoteAmountWei(0.1, () => 0)).toBe('100000001000000000');
    // rng just below 1 → maximum dust of 99_999 gwei
    expect(quoteAmountWei(0.1, () => 0.9999999)).toBe('100099999000000000');
  });

  it('formats wei back to a trimmed ETH string for display', () => {
    expect(formatEth('100000001000000000')).toBe('0.100000001');
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

describe('matchPayments', () => {
  const order = (id: number, amountWei: string) => ({
    id, chatId: 1, address: '0xCA', symbol: 'HOOD', tier: 'top3', hours: 6,
    amountWei, status: 'pending' as const, createdAt: 0, paidAt: null, txHash: null, rank: null, expiresAt: null,
  });

  it('matches a tx to the payment address with the exact quoted value', () => {
    const matches = matchPayments(
      [order(1, '100000001000000000')],
      [{ to: PROMO.paymentAddress, value: 100000001000000000n, hash: '0xT1' }],
      PROMO.paymentAddress,
    );
    expect(matches).toEqual([{ orderId: 1, txHash: '0xT1' }]);
  });

  it('ignores wrong amounts, other recipients, and case-differences in to-address are tolerated', () => {
    const matches = matchPayments(
      [order(1, '100000001000000000')],
      [
        { to: PROMO.paymentAddress, value: 100000000000000000n, hash: '0xWRONG' }, // amount mismatch
        { to: '0xdeadbeef00000000000000000000000000000000', value: 100000001000000000n, hash: '0xELSE' },
        { to: PROMO.paymentAddress.toUpperCase().replace('0X', '0x'), value: 100000001000000000n, hash: '0xT1' },
      ],
      PROMO.paymentAddress,
    );
    expect(matches).toEqual([{ orderId: 1, txHash: '0xT1' }]);
  });

  it('each order matches at most once', () => {
    const matches = matchPayments(
      [order(1, '5')],
      [
        { to: PROMO.paymentAddress, value: 5n, hash: '0xA' },
        { to: PROMO.paymentAddress, value: 5n, hash: '0xB' },
      ],
      PROMO.paymentAddress,
    );
    expect(matches).toEqual([{ orderId: 1, txHash: '0xA' }]);
  });
});

describe('PaymentWatcher', () => {
  function rpc(blocks: Record<number, Array<{ to: string | null; value: string; hash: string }>>, latest: number) {
    const calls: string[] = [];
    const fetchFn = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const reply = (result: unknown, id: unknown) => ({ jsonrpc: '2.0', id, result });
      const out = Array.isArray(body)
        ? body.map((req: any) => handle(req))
        : handle(body);
      return { ok: true, json: async () => out } as Response;

      function handle(req: any): unknown {
        calls.push(req.method);
        if (req.method === 'eth_blockNumber') return reply('0x' + latest.toString(16), req.id);
        const n = parseInt(req.params[0], 16);
        const txs = (blocks[n] ?? []).map((t) => ({ to: t.to, value: t.value, hash: t.hash }));
        return reply({ number: req.params[0], transactions: txs }, req.id);
      }
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }

  it('scans confirmed blocks once and returns exact-amount matches for pending orders', async () => {
    const db = new Db(':memory:');
    const id = db.createOrder({ chatId: 7, address: '0xCA', symbol: 'HOOD', tier: 'top3', hours: 6, amountWei: '1000', now: 0 });
    // latest=13, confirmations=3 → scan up to block 10
    const { fetchFn } = rpc({ 10: [{ to: PROMO.paymentAddress, value: '0x3e8', hash: '0xT1' }] }, 13);
    const w = new PaymentWatcher('https://rpc.example', PROMO, db, fetchFn);
    db.setMeta('last_scanned_block', '9');

    const matches = await w.tick();
    expect(matches).toEqual([{ orderId: id, txHash: '0xT1' }]);
    expect(db.getMeta('last_scanned_block')).toBe('10');

    // second tick: nothing new to scan, no re-match
    expect(await w.tick()).toEqual([]);
    db.close();
  });

  it('with no pending orders it fast-forwards the scan cursor without fetching blocks', async () => {
    const db = new Db(':memory:');
    const { fetchFn, calls } = rpc({}, 50);
    const w = new PaymentWatcher('https://rpc.example', PROMO, db, fetchFn);
    expect(await w.tick()).toEqual([]);
    expect(db.getMeta('last_scanned_block')).toBe('47'); // latest - confirmations
    expect(calls).toEqual(['eth_blockNumber']); // no eth_getBlockByNumber calls
    db.close();
  });
});

describe('formatLeaderboard', () => {
  const t = (symbol: string, address: string, mc: number): GmgnToken =>
    ({ symbol, address, marketCapUsd: mc } as GmgnToken);
  const paid = (rank: number, symbol: string, address: string) => ({
    id: rank, chatId: 1, address, symbol, tier: 'top3', hours: 6, amountWei: '1',
    status: 'active' as const, createdAt: 0, paidAt: 0, txHash: '0xT', rank, expiresAt: 99,
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
