import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PostRow {
  messageId: number;
  postedAt: number;
  sponsored: number;
}

export type OrderStatus = 'pending' | 'active' | 'expired' | 'cancelled';

export interface OrderRow {
  id: number;
  chatId: number;
  address: string;
  symbol: string;
  tier: string;
  hours: number;
  /** Exact quoted payment amount in wei, as a decimal string. */
  amountWei: string;
  /** Per-order deposit wallet the buyer pays into (derived from the promo seed). */
  depositAddress: string;
  derivIndex: number;
  status: OrderStatus;
  createdAt: number;
  paidAt: number | null;
  txHash: string | null;
  rank: number | null;
  expiresAt: number | null;
  /** Hash of the sweep tx that forwarded the deposit into the treasury (null until swept). */
  sweepTx: string | null;
  /** 1 = complimentary admin listing (no payment, no deposit wallet, never swept). */
  comp: number;
}

export interface OrderDraft {
  chatId: number;
  address: string;
  symbol: string;
  tier: string;
  hours: number;
  amountWei: string;
  depositAddress: string;
  derivIndex: number;
  now: number;
  /** True for a complimentary admin listing (skips payment). */
  comp?: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  first_seen INTEGER,
  outcome TEXT DEFAULT 'seen'
);

CREATE TABLE IF NOT EXISTS posts (
  address TEXT PRIMARY KEY,
  message_id INTEGER,
  posted_at INTEGER,
  sponsored INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  tier TEXT NOT NULL,
  hours INTEGER NOT NULL,
  amount_wei TEXT NOT NULL,
  deposit_address TEXT NOT NULL DEFAULT '',
  deriv_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  tx_hash TEXT,
  rank INTEGER,
  expires_at INTEGER,
  sweep_tx TEXT,
  comp INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const ORDER_COLS = `id, chat_id AS chatId, address, symbol, tier, hours, amount_wei AS amountWei,
  deposit_address AS depositAddress, deriv_index AS derivIndex, status, created_at AS createdAt,
  paid_at AS paidAt, tx_hash AS txHash, rank, expires_at AS expiresAt, sweep_tx AS sweepTx, comp`;

export class Db {
  private db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  /** First-sight record for a token; leaves `outcome` at its default 'seen'. Idempotent. */
  recordSeen(address: string, symbol: string, name: string, now: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO tokens (address, symbol, name, first_seen, outcome)
         VALUES (?, ?, ?, ?, 'seen')`,
      )
      .run(address, symbol, name, now);
  }

  /** The `first_seen` timestamp recorded by `recordSeen` for this address, or null if it has
   * never been seen. Backs runCycle's post-gate grace period (Task 13): how long ago a token
   * first appeared, independent of whether its GeckoTerminal info has been cached yet. */
  firstSeen(address: string): number | null {
    const row = this.db.prepare('SELECT first_seen FROM tokens WHERE address = ?').get(address) as
      | { first_seen: number }
      | undefined;
    return row ? row.first_seen : null;
  }

  /** True once a Telegram post row exists for this address (dedupe gate). */
  alreadyPosted(address: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM posts WHERE address = ?').get(address);
  }

  /** Records a token as posted. Idempotent — a repeat call for the same address is a no-op. */
  recordPost(address: string, messageId: number, now: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO posts (address, message_id, posted_at, sponsored)
         VALUES (?, ?, ?, 0)`,
      )
      .run(address, messageId, now);
  }

  /** Total number of posts ever recorded. 0 means "cold start" — nothing has been posted yet,
   * used by runCycle (Task G4) to silently seed the current gate-passers instead of alerting. */
  postCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM posts').get() as { c: number };
    return row.c;
  }

  getPost(address: string): PostRow | null {
    const row = this.db
      .prepare(
        'SELECT message_id AS messageId, posted_at AS postedAt, sponsored FROM posts WHERE address = ?',
      )
      .get(address) as PostRow | undefined;
    return row ?? null;
  }

  // --- promo orders (paid ⭐ leaderboard slots) -------------------------------------------

  /** Creates a pending order (slot reservation) and returns its id. */
  createOrder(d: OrderDraft): number {
    const r = this.db
      .prepare(
        `INSERT INTO orders (chat_id, address, symbol, tier, hours, amount_wei, deposit_address, deriv_index, status, created_at, comp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(d.chatId, d.address, d.symbol, d.tier, d.hours, d.amountWei, d.depositAddress, d.derivIndex, d.now, d.comp ? 1 : 0);
    return Number(r.lastInsertRowid);
  }

  /** Pending complimentary (admin) listings — activated without payment on the next promo tick. */
  pendingCompOrders(): OrderRow[] {
    return this.db.prepare(`SELECT ${ORDER_COLS} FROM orders WHERE status = 'pending' AND comp = 1 ORDER BY id`).all() as OrderRow[];
  }

  /** Attach the derived deposit wallet to an order once its id (hence derivation index) is known. */
  setOrderDeposit(id: number, depositAddress: string, derivIndex: number): void {
    this.db.prepare(`UPDATE orders SET deposit_address = ?, deriv_index = ? WHERE id = ?`).run(depositAddress, derivIndex, id);
  }

  getOrder(id: number): OrderRow | null {
    const row = this.db.prepare(`SELECT ${ORDER_COLS} FROM orders WHERE id = ?`).get(id) as OrderRow | undefined;
    return row ?? null;
  }

  pendingOrders(): OrderRow[] {
    return this.db.prepare(`SELECT ${ORDER_COLS} FROM orders WHERE status = 'pending' ORDER BY id`).all() as OrderRow[];
  }

  activeOrders(now: number): OrderRow[] {
    return this.db
      .prepare(`SELECT ${ORDER_COLS} FROM orders WHERE status = 'active' AND expires_at > ? ORDER BY rank`)
      .all(now) as OrderRow[];
  }

  /** Open (pending + active) order count per tier — the inventory check for the slot menu. */
  openOrderCountByTier(tier: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM orders WHERE tier = ? AND status IN ('pending', 'active')`)
      .get(tier) as { c: number };
    return row.c;
  }

  markPaid(id: number, txHash: string, rank: number, paidAt: number, expiresAt: number): void {
    this.db
      .prepare(`UPDATE orders SET status = 'active', tx_hash = ?, rank = ?, paid_at = ?, expires_at = ? WHERE id = ?`)
      .run(txHash, rank, paidAt, expiresAt, id);
  }

  /** Records the sweep tx that forwarded a paid order's deposit into the treasury. */
  markSwept(id: number, sweepTx: string): void {
    this.db.prepare(`UPDATE orders SET sweep_tx = ? WHERE id = ?`).run(sweepTx, id);
  }

  /** Paid orders whose deposit hasn't been forwarded to the treasury yet — the sweep worklist
   * (includes already-expired ones so funds are never stranded when a slot lapses). */
  unsweptPaidOrders(): OrderRow[] {
    return this.db
      .prepare(`SELECT ${ORDER_COLS} FROM orders WHERE tx_hash IS NOT NULL AND sweep_tx IS NULL AND comp = 0 ORDER BY id`)
      .all() as OrderRow[];
  }

  /** Cancels pending orders created before `cutoff` (unpaid reservation timeout); returns them
   * so the caller can notify the buyer. */
  cancelPendingBefore(cutoff: number): OrderRow[] {
    const rows = this.db
      .prepare(`SELECT ${ORDER_COLS} FROM orders WHERE status = 'pending' AND created_at < ?`)
      .all(cutoff) as OrderRow[];
    if (rows.length) {
      this.db.prepare(`UPDATE orders SET status = 'cancelled' WHERE status = 'pending' AND created_at < ?`).run(cutoff);
    }
    return rows;
  }

  /** Expires active orders whose slot has lapsed; returns them so their ranks free up. */
  expireActiveBefore(now: number): OrderRow[] {
    const rows = this.db
      .prepare(`SELECT ${ORDER_COLS} FROM orders WHERE status = 'active' AND expires_at <= ?`)
      .all(now) as OrderRow[];
    if (rows.length) {
      this.db.prepare(`UPDATE orders SET status = 'expired' WHERE status = 'active' AND expires_at <= ?`).run(now);
    }
    return rows;
  }

  /** Leaderboard ranks currently held by live paid slots. */
  usedRanks(now: number): number[] {
    return (this.activeOrders(now).map((o) => o.rank).filter((r) => r !== null) as number[]).sort((a, b) => a - b);
  }

  // --- meta kv (leaderboard message id, last scanned block) --------------------------------

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
