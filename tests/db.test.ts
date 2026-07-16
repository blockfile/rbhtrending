import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Db } from '../src/db/index';

describe('Db schema migration', () => {
  it('backfills promo columns on an orders table created before they existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rbh-mig-'));
    const path = join(dir, 'old.db');
    // simulate a DB from an older deploy: orders table WITHOUT the per-order-wallet / comp columns
    const old = new Database(path);
    old.exec(`CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, address TEXT NOT NULL,
      symbol TEXT NOT NULL, tier TEXT NOT NULL, hours INTEGER NOT NULL, amount_wei TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, paid_at INTEGER,
      tx_hash TEXT, rank INTEGER, expires_at INTEGER)`);
    old.close();

    const db = new Db(path); // constructor must migrate the existing table, not leave it stale
    const id = db.createOrder({
      chatId: 1, address: '0xCA', symbol: 'X', tier: 'top3', hours: 6,
      amountWei: '0', depositAddress: '0xdep', derivIndex: 2, now: 1000,
    });
    const o = db.getOrder(id)!;
    expect(o.depositAddress).toBe('0xdep');
    expect(o.derivIndex).toBe(2);
    expect(o.comp).toBe(0);
    expect(o.sweepTx).toBeNull();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Db', () => {
  let db: Db;

  beforeEach(() => {
    db = new Db(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('recordSeen / alreadyPosted', () => {
    it('a freshly-seen token has not been posted', () => {
      db.recordSeen('0xAAA', 'FOO', 'Foo Token', 1000);
      expect(db.alreadyPosted('0xAAA')).toBe(false);
    });

    it('a token with no recordSeen at all has not been posted', () => {
      expect(db.alreadyPosted('0xNEVERSEEN')).toBe(false);
    });

    it('becomes posted after recordPost', () => {
      db.recordSeen('0xAAA', 'FOO', 'Foo Token', 1000);
      db.recordPost('0xAAA', 555, 2000);
      expect(db.alreadyPosted('0xAAA')).toBe(true);
    });

    it('recordSeen is idempotent — inserting the same address twice does not throw', () => {
      db.recordSeen('0xAAA', 'FOO', 'Foo Token', 1000);
      expect(() => db.recordSeen('0xAAA', 'FOO', 'Foo Token', 2000)).not.toThrow();
    });
  });

  describe('firstSeen', () => {
    it('returns null for an address that was never seen', () => {
      expect(db.firstSeen('0xNEVER')).toBeNull();
    });

    it('returns the stored first_seen timestamp after recordSeen', () => {
      db.recordSeen('0xAAA', 'FOO', 'Foo Token', 1000);
      expect(db.firstSeen('0xAAA')).toBe(1000);
    });

    it('keeps the original timestamp — a later recordSeen for the same address does not overwrite it', () => {
      db.recordSeen('0xAAA', 'FOO', 'Foo Token', 1000);
      db.recordSeen('0xAAA', 'FOO', 'Foo Token', 5000);
      expect(db.firstSeen('0xAAA')).toBe(1000);
    });
  });

  describe('recordPost / getPost', () => {
    it('round-trips messageId and postedAt, defaulting sponsored to 0', () => {
      db.recordPost('0xBBB', 999, 12345);
      expect(db.getPost('0xBBB')).toEqual({ messageId: 999, postedAt: 12345, sponsored: 0 });
    });

    it('returns null for a token that was never posted', () => {
      expect(db.getPost('0xNOPE')).toBeNull();
    });

    it('recordPost is idempotent — a second call for the same address does not overwrite the first', () => {
      db.recordPost('0xCCC', 111, 1000);
      db.recordPost('0xCCC', 222, 2000);
      expect(db.getPost('0xCCC')).toEqual({ messageId: 111, postedAt: 1000, sponsored: 0 });
    });
  });

  describe('postCount', () => {
    it('is 0 when no posts have ever been recorded (cold start)', () => {
      expect(db.postCount()).toBe(0);
    });

    it('counts recorded posts', () => {
      db.recordPost('0xAAA', 1, 1000);
      db.recordPost('0xBBB', 2, 2000);
      expect(db.postCount()).toBe(2);
    });

    it('does not double-count an idempotent repeat recordPost for the same address', () => {
      db.recordPost('0xAAA', 1, 1000);
      db.recordPost('0xAAA', 2, 2000);
      expect(db.postCount()).toBe(1);
    });
  });
});

describe('Db promo orders', () => {
  let db: Db;
  beforeEach(() => { db = new Db(':memory:'); });
  afterEach(() => { db.close(); });

  const draft = {
    chatId: 777, address: '0xCA', symbol: 'HOOD', tier: 'top3' as const,
    hours: 6, amountWei: '100000000000000000', depositAddress: '0xdep01', derivIndex: 0, now: 1000,
  };

  it('creates a pending order and reads it back', () => {
    const id = db.createOrder(draft);
    const o = db.getOrder(id)!;
    expect(o.status).toBe('pending');
    expect(o.chatId).toBe(777);
    expect(o.address).toBe('0xCA');
    expect(o.tier).toBe('top3');
    expect(o.hours).toBe(6);
    expect(o.amountWei).toBe('100000000000000000');
    expect(o.depositAddress).toBe('0xdep01');
    expect(o.derivIndex).toBe(0);
    expect(o.createdAt).toBe(1000);
    expect(o.rank).toBeNull();
    expect(o.sweepTx).toBeNull();
  });

  it('lists pending orders', () => {
    db.createOrder(draft);
    expect(db.pendingOrders()).toHaveLength(1);
    expect(db.pendingOrders()[0].depositAddress).toBe('0xdep01');
  });

  it('finds the active order for a token address (case-insensitive), and delistOrder frees its rank', () => {
    const id = db.createOrder({ ...draft, address: '0xAbCdEf' });
    db.markPaid(id, '0xTX', 1, 2000, 999_999);
    // active-by-address lookup is case-insensitive
    expect(db.activeOrderByAddress('0xabcdef')!.id).toBe(id);
    expect(db.usedRanks(3000)).toEqual([1]);

    const removed = db.delistOrder(id)!;
    expect(removed.id).toBe(id);
    expect(db.getOrder(id)!.status).toBe('delisted');
    expect(db.activeOrders(3000)).toHaveLength(0); // off the board
    expect(db.usedRanks(3000)).toEqual([]); // rank freed
    expect(db.activeOrderByAddress('0xabcdef')).toBeNull();
  });

  it('setOrderRank moves an active order to a new rank', () => {
    const id = db.createOrder(draft);
    db.markPaid(id, '0xTX', 2, 0, 999_999);
    db.setOrderRank(id, 1);
    expect(db.getOrder(id)!.rank).toBe(1);
    expect(db.usedRanks(1000)).toEqual([1]);
  });

  it('activeOrderByAddress returns null for an unknown or non-active token', () => {
    const id = db.createOrder(draft); // pending, not active
    expect(db.activeOrderByAddress(draft.address)).toBeNull();
    expect(db.delistOrder(999)).toBeNull(); // no such order
    expect(db.getOrder(id)!.status).toBe('pending');
  });

  it('records bump time + message id for an active promoted slot', () => {
    const id = db.createOrder(draft);
    let o = db.getOrder(id)!;
    expect(o.lastBumpedAt).toBeNull();
    expect(o.bumpMsgId).toBeNull();
    db.recordBump(id, 5000, 4242);
    o = db.getOrder(id)!;
    expect(o.lastBumpedAt).toBe(5000);
    expect(o.bumpMsgId).toBe(4242);
    // a later bump overwrites both (previous message gets deleted by the caller)
    db.recordBump(id, 8000, 9999);
    o = db.getOrder(id)!;
    expect(o.lastBumpedAt).toBe(8000);
    expect(o.bumpMsgId).toBe(9999);
  });

  it('tracks sweep status: paid-but-unswept worklist, cleared by markSwept', () => {
    const id = db.createOrder(draft);
    expect(db.unsweptPaidOrders()).toHaveLength(0); // not paid yet
    db.markPaid(id, '0xTX', 1, 2000, 9_999);
    expect(db.unsweptPaidOrders().map((o) => o.id)).toEqual([id]);
    db.markSwept(id, '0xSWEEP');
    expect(db.unsweptPaidOrders()).toHaveLength(0);
    expect(db.getOrder(id)!.sweepTx).toBe('0xSWEEP');
  });

  it('counts open (pending + active) orders per tier for inventory', () => {
    const a = db.createOrder(draft);
    db.createOrder({ ...draft, address: '0xCB' });
    db.createOrder({ ...draft, address: '0xCC', tier: 'top8' });
    db.markPaid(a, '0xTX', 1, 2000, 50_000);
    expect(db.openOrderCountByTier('top3')).toBe(2); // one active + one pending
    expect(db.openOrderCountByTier('top8')).toBe(1);
    expect(db.openOrderCountByTier('top12')).toBe(0);
  });

  it('markPaid activates the order with tx, rank, and expiry', () => {
    const id = db.createOrder(draft);
    db.markPaid(id, '0xTXHASH', 2, 2000, 2000 + 6 * 3_600_000);
    const o = db.getOrder(id)!;
    expect(o.status).toBe('active');
    expect(o.txHash).toBe('0xTXHASH');
    expect(o.rank).toBe(2);
    expect(o.paidAt).toBe(2000);
    expect(o.expiresAt).toBe(2000 + 6 * 3_600_000);
    expect(db.activeOrders(3000)).toHaveLength(1);
    expect(db.usedRanks(3000)).toEqual([2]);
  });

  it('cancelPendingBefore cancels only stale pending orders and returns them', () => {
    const stale = db.createOrder({ ...draft, now: 1000 });
    db.createOrder({ ...draft, address: '0xCB', now: 9000 });
    const cancelled = db.cancelPendingBefore(5000);
    expect(cancelled.map((o) => o.id)).toEqual([stale]);
    expect(db.getOrder(stale)!.status).toBe('cancelled');
    expect(db.pendingOrders()).toHaveLength(1);
  });

  it('expireActiveBefore expires lapsed active orders and frees their ranks', () => {
    const id = db.createOrder(draft);
    db.markPaid(id, '0xTX', 1, 2000, 10_000);
    expect(db.expireActiveBefore(9_999)).toHaveLength(0);
    const expired = db.expireActiveBefore(10_000);
    expect(expired.map((o) => o.id)).toEqual([id]);
    expect(db.getOrder(id)!.status).toBe('expired');
    expect(db.usedRanks(11_000)).toEqual([]);
  });

  it('meta kv stores and overwrites string values', () => {
    expect(db.getMeta('leaderboard_msg')).toBeNull();
    db.setMeta('leaderboard_msg', '42');
    expect(db.getMeta('leaderboard_msg')).toBe('42');
    db.setMeta('leaderboard_msg', '43');
    expect(db.getMeta('leaderboard_msg')).toBe('43');
  });
});

describe('Db comp (admin free) orders', () => {
  let db: Db;
  beforeEach(() => { db = new Db(':memory:'); });
  afterEach(() => db.close());

  const draft = (over = {}) => ({
    chatId: 1, address: '0xCA', symbol: 'HOOD', tier: 'top3' as const, hours: 6,
    amountWei: '0', depositAddress: '', derivIndex: 0, now: 1000, ...over,
  });

  it('marks an order as comp and lists it via pendingCompOrders', () => {
    const paidId = db.createOrder(draft());
    const compId = db.createOrder(draft({ comp: true, address: '0xADMIN' }));
    expect(db.getOrder(compId)!.comp).toBe(1);
    expect(db.getOrder(paidId)!.comp).toBe(0);
    expect(db.pendingCompOrders().map((o) => o.id)).toEqual([compId]);
  });

  it('once activated, a comp order is no longer pending-comp', () => {
    const id = db.createOrder(draft({ comp: true }));
    db.markPaid(id, 'comp', 1, 2000, 9_999);
    expect(db.pendingCompOrders()).toHaveLength(0);
  });

  it('never lists comp orders for sweeping (they have no deposit funds)', () => {
    const id = db.createOrder(draft({ comp: true }));
    db.markPaid(id, 'comp', 1, 2000, 9_999);
    expect(db.unsweptPaidOrders()).toHaveLength(0);
  });
});
