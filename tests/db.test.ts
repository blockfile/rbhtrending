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
