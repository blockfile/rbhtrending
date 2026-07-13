import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PostRow {
  messageId: number;
  postedAt: number;
  sponsored: number;
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
`;

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

  getPost(address: string): PostRow | null {
    const row = this.db
      .prepare(
        'SELECT message_id AS messageId, posted_at AS postedAt, sponsored FROM posts WHERE address = ?',
      )
      .get(address) as PostRow | undefined;
    return row ?? null;
  }

  close(): void {
    this.db.close();
  }
}
