import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PromoService } from '../src/promo/service';
import { decodeAbiString } from '../src/promo/erc20';
import { Db } from '../src/db/index';
import type { GmgnToken, PromoConfig } from '../src/types';

const PROMO: PromoConfig = {
  enabled: true,
  paymentAddress: '0xpay0000000000000000000000000000000000aa',
  confirmations: 3,
  leaderboardSize: 12,
  pendingMinutes: 60,
  tiers: {
    top3: { maxRank: 3, slots: 3, prices: { '3': 0.1, '6': 0.18, '24': 0.6 } },
    top8: { maxRank: 8, slots: 5, prices: { '3': 0.08, '6': 0.14, '24': 0.45 } },
    top12: { maxRank: 12, slots: 4, prices: { '3': 0.06, '6': 0.1, '24': 0.35 } },
  },
};

const HOUR = 3_600_000;

function fakeTg() {
  const channel: Array<{ text: string; buttons?: unknown }> = [];
  const dms: Array<{ chatId: number; text: string }> = [];
  const edits: Array<{ messageId: number; text: string }> = [];
  const pins: number[] = [];
  return {
    channel, dms, edits, pins,
    send: async (p: any) => {
      const payload = typeof p === 'string' ? { text: p } : p;
      channel.push(payload);
      return { ok: true, messageId: 100 + channel.length };
    },
    sendTo: async (chatId: number, p: any) => {
      dms.push({ chatId, text: (typeof p === 'string' ? { text: p } : p).text });
      return { ok: true };
    },
    editCaption: async (messageId: number, text: string) => {
      edits.push({ messageId, text });
      return true;
    },
    pinChatMessage: async (id: number) => { pins.push(id); return true; },
    getMe: async () => 'robintrenchbot',
  };
}

const token = (symbol: string, address: string, mc: number): GmgnToken =>
  ({ symbol, address, marketCapUsd: mc } as GmgnToken);

describe('PromoService', () => {
  let db: Db;
  let tg: ReturnType<typeof fakeTg>;

  beforeEach(() => {
    db = new Db(':memory:');
    tg = fakeTg();
  });
  afterEach(() => db.close());

  function service(matches: Array<{ orderId: number; txHash: string }>[] = []) {
    let call = 0;
    const watcher = { tick: async () => matches[call++] ?? [] };
    return new PromoService(tg, db, PROMO, watcher);
  }

  it('activates a paid order: rank assigned, buyer notified, ⭐ card posted, leaderboard pinned', async () => {
    const id = db.createOrder({ chatId: 7, address: '0xca', symbol: 'BLEP', tier: 'top3', hours: 6, amountWei: '1', now: 1000 });
    const svc = service([[{ orderId: id, txHash: '0xTX' }]]);

    await svc.tick([token('AAA', '0xa', 1000)], 2000);

    const o = db.getOrder(id)!;
    expect(o.status).toBe('active');
    expect(o.rank).toBe(1);
    expect(o.expiresAt).toBe(2000 + 6 * HOUR);

    expect(tg.dms.some((d) => d.chatId === 7 && d.text.includes('live'))).toBe(true);
    expect(tg.channel.some((m) => m.text.includes('PROMOTED') && m.text.includes('BLEP'))).toBe(true);

    const lb = tg.channel.find((m) => m.text.includes('ROBINHOOD TRENDING'))!;
    expect(lb.text).toContain('1. ⭐');
    expect(tg.pins).toHaveLength(1);
    expect(db.getMeta('leaderboard_msg')).toBeTruthy();
  });

  it('edits the existing pinned leaderboard on later ticks instead of re-sending', async () => {
    const svc = service();
    await svc.tick([token('AAA', '0xa', 1000)], 1000);
    const sentBefore = tg.channel.length;
    await svc.tick([token('AAA', '0xa', 2000)], 2000);
    expect(tg.channel.length).toBe(sentBefore); // no new channel message
    expect(tg.edits).toHaveLength(1);
    expect(tg.edits[0].messageId).toBe(Number(db.getMeta('leaderboard_msg')));
  });

  it('cancels stale pending orders and tells the buyer', async () => {
    db.createOrder({ chatId: 9, address: '0xca', symbol: 'BLEP', tier: 'top3', hours: 6, amountWei: '1', now: 0 });
    const svc = service();
    await svc.tick([], PROMO.pendingMinutes * 60_000 + 1);
    expect(db.pendingOrders()).toHaveLength(0);
    expect(tg.dms.some((d) => d.chatId === 9 && d.text.toLowerCase().includes('expired'))).toBe(true);
  });

  it('expires lapsed slots, frees the rank, and notifies the buyer', async () => {
    const id = db.createOrder({ chatId: 5, address: '0xca', symbol: 'BLEP', tier: 'top3', hours: 3, amountWei: '1', now: 0 });
    db.markPaid(id, '0xTX', 1, 0, 3 * HOUR);
    const svc = service();

    await svc.tick([token('AAA', '0xa', 1000)], 3 * HOUR + 1);

    expect(db.getOrder(id)!.status).toBe('expired');
    expect(db.usedRanks(3 * HOUR + 2)).toEqual([]);
    expect(tg.dms.some((d) => d.chatId === 5 && d.text.includes('ended'))).toBe(true);
    const lb = tg.channel.find((m) => m.text.includes('ROBINHOOD TRENDING'))!;
    expect(lb.text).not.toContain('⭐ <a'); // no paid rows left
  });
});

describe('decodeAbiString', () => {
  it('decodes a standard ABI-encoded string return ("BLEP")', () => {
    const hex = '0x'
      + '0000000000000000000000000000000000000000000000000000000000000020'
      + '0000000000000000000000000000000000000000000000000000000000000004'
      + '424c455000000000000000000000000000000000000000000000000000000000';
    expect(decodeAbiString(hex)).toBe('BLEP');
  });

  it('decodes a legacy bytes32 symbol and trims the padding', () => {
    const hex = '0x4d4b520000000000000000000000000000000000000000000000000000000000'; // "MKR"
    expect(decodeAbiString(hex)).toBe('MKR');
  });

  it('returns null for empty or unparseable results', () => {
    expect(decodeAbiString('0x')).toBeNull();
    expect(decodeAbiString(undefined)).toBeNull();
  });
});
