import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Db } from '../src/db/index';

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
});
