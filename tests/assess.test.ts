import { describe, it, expect } from 'vitest';
import { assess } from '../src/checks/assess';
import type { GmgnToken } from '../src/types';

/** A fully "clean" GmgnToken: no security red flags, healthy depth counts. */
function token(overrides: Partial<GmgnToken> = {}): GmgnToken {
  return {
    address: '0xCA00000000000000000000000000000000CAFE',
    name: 'Cool Token',
    symbol: 'HOOD',
    priceUsd: 0.0042,
    priceChange1hPct: 12.3,
    volumeUsd: 27600,
    liquidityUsd: 12300,
    marketCapUsd: 184000,
    athMarketCapUsd: 240000,
    swaps: 512,
    buys: 41,
    sells: 30,
    holderCount: 341,
    top10Pct: 21,
    createdAt: 1752300000000,
    twitter: 'https://x.com/dev',
    telegram: 'https://t.me/c',
    website: undefined,
    honeypot: false,
    buyTaxPct: 0,
    sellTaxPct: 0,
    renounced: true,
    verified: true,
    lpLockedPct: 95,
    devHoldPct: 5,
    rugRatioPct: 0,
    burnPct: 0,
    smartMoneyCount: 12,
    kolCount: 14,
    sniperCount: 3,
    bundlerRatePct: 0,
    washTrading: false,
    hotLevel: 3,
    ...overrides,
  };
}

/** Same clean baseline but with the smart-money/KOL bonuses zeroed out, so score deltas below
 * can be asserted exactly without the +10 bonus pushing the total into the 100-clamp. */
function neutralToken(overrides: Partial<GmgnToken> = {}): GmgnToken {
  return token({ smartMoneyCount: 0, kolCount: 0, ...overrides });
}

describe('assess', () => {
  describe('a fully clean token', () => {
    it('grades safe with no flags', () => {
      const a = assess(token());
      expect(a.grade).toBe('safe');
      expect(a.flags).toEqual([]);
    });

    it('scores 100 (bonuses clamped) with the default smart-money/KOL depth', () => {
      expect(assess(token()).score).toBe(100);
    });

    it('scores exactly 100 with no smart-money/KOL bonus at all', () => {
      expect(assess(neutralToken()).score).toBe(100);
    });
  });

  describe('flags — each triggers at its threshold and not below', () => {
    it('honeypot pushes "honeypot"', () => {
      expect(assess(token({ honeypot: true })).flags).toEqual(['honeypot']);
      expect(assess(token({ honeypot: false })).flags).toEqual([]);
    });

    it('sellTaxPct > 10 pushes "sell tax N%", rounded, not at exactly 10', () => {
      expect(assess(token({ sellTaxPct: 10 })).flags).toEqual([]);
      expect(assess(token({ sellTaxPct: 11 })).flags).toEqual(['sell tax 11%']);
      expect(assess(token({ sellTaxPct: 11.6 })).flags).toEqual(['sell tax 12%']);
    });

    it('lpLockedPct < 50 pushes "LP not locked", not at exactly 50', () => {
      expect(assess(token({ lpLockedPct: 50 })).flags).toEqual([]);
      expect(assess(token({ lpLockedPct: 49 })).flags).toEqual(['LP not locked']);
    });

    it('!renounced pushes "owner active"', () => {
      expect(assess(token({ renounced: false })).flags).toEqual(['owner active']);
      expect(assess(token({ renounced: true })).flags).toEqual([]);
    });

    it('!verified pushes "unverified"', () => {
      expect(assess(token({ verified: false })).flags).toEqual(['unverified']);
      expect(assess(token({ verified: true })).flags).toEqual([]);
    });

    it('top10Pct > 50 pushes "top 10 owns N%", rounded, not at exactly 50', () => {
      expect(assess(token({ top10Pct: 50 })).flags).toEqual([]);
      expect(assess(token({ top10Pct: 51 })).flags).toEqual(['top 10 owns 51%']);
    });

    it('devHoldPct > 15 pushes "dev holds N%", rounded, not at exactly 15', () => {
      expect(assess(token({ devHoldPct: 15 })).flags).toEqual([]);
      expect(assess(token({ devHoldPct: 16 })).flags).toEqual(['dev holds 16%']);
    });

    it('washTrading pushes "wash trading"', () => {
      expect(assess(token({ washTrading: true })).flags).toEqual(['wash trading']);
      expect(assess(token({ washTrading: false })).flags).toEqual([]);
    });

    it('pushes every triggered flag in the documented order', () => {
      const allBad = token({
        honeypot: true,
        sellTaxPct: 50,
        lpLockedPct: 10,
        renounced: false,
        verified: false,
        top10Pct: 80,
        devHoldPct: 30,
        washTrading: true,
      });
      expect(assess(allBad).flags).toEqual([
        'honeypot',
        'sell tax 50%',
        'LP not locked',
        'owner active',
        'unverified',
        'top 10 owns 80%',
        'dev holds 30%',
        'wash trading',
      ]);
    });
  });

  describe('grade', () => {
    it('is safe for a fully clean token', () => {
      expect(assess(token()).grade).toBe('safe');
    });

    it('is warn when flags exist but no danger condition is met', () => {
      expect(assess(token({ devHoldPct: 16 })).grade).toBe('warn');
    });

    it('honeypot forces danger even if nothing else is wrong', () => {
      expect(assess(token({ honeypot: true })).grade).toBe('danger');
    });

    it('sellTaxPct > 30 forces danger even if nothing else is wrong', () => {
      expect(assess(token({ sellTaxPct: 31 })).grade).toBe('danger');
      // boundary: exactly 30 does not force danger (still a flag => warn)
      expect(assess(token({ sellTaxPct: 30 })).grade).toBe('warn');
    });

    it('lpLockedPct < 20 forces danger even if nothing else is wrong', () => {
      expect(assess(token({ lpLockedPct: 19 })).grade).toBe('danger');
      // boundary: exactly 20 does not force danger (still a flag => warn, since <50)
      expect(assess(token({ lpLockedPct: 20 })).grade).toBe('warn');
    });
  });

  describe('score', () => {
    it('honeypot subtracts 80', () => {
      expect(assess(neutralToken({ honeypot: true })).score).toBe(20);
    });

    it('an active (non-renounced) owner subtracts 12', () => {
      expect(assess(neutralToken({ renounced: false })).score).toBe(88);
    });

    it('an unverified contract subtracts 8', () => {
      expect(assess(neutralToken({ verified: false })).score).toBe(92);
    });

    it('LP-lock tiers: <20% subtracts 30, 20-50% subtracts 15, >=50% subtracts nothing', () => {
      expect(assess(neutralToken({ lpLockedPct: 19 })).score).toBe(70);
      expect(assess(neutralToken({ lpLockedPct: 49 })).score).toBe(85);
      expect(assess(neutralToken({ lpLockedPct: 50 })).score).toBe(100);
    });

    it('sell-tax tiers: >30% subtracts 30, >10% subtracts 15, <=10% subtracts nothing', () => {
      expect(assess(neutralToken({ sellTaxPct: 31 })).score).toBe(70);
      expect(assess(neutralToken({ sellTaxPct: 11 })).score).toBe(85);
      expect(assess(neutralToken({ sellTaxPct: 10 })).score).toBe(100);
    });

    it('top-10 tiers: >70% subtracts 25, >50% subtracts 12, <=50% subtracts nothing', () => {
      expect(assess(neutralToken({ top10Pct: 71 })).score).toBe(75);
      expect(assess(neutralToken({ top10Pct: 51 })).score).toBe(88);
      expect(assess(neutralToken({ top10Pct: 50 })).score).toBe(100);
    });

    it('devHoldPct > 15% subtracts 12, not at exactly 15%', () => {
      expect(assess(neutralToken({ devHoldPct: 16 })).score).toBe(88);
      expect(assess(neutralToken({ devHoldPct: 15 })).score).toBe(100);
    });

    it('washTrading subtracts 20', () => {
      expect(assess(neutralToken({ washTrading: true })).score).toBe(80);
    });

    it('rugRatioPct > 50% subtracts 20, not at exactly 50%', () => {
      expect(assess(neutralToken({ rugRatioPct: 51 })).score).toBe(80);
      expect(assess(neutralToken({ rugRatioPct: 50 })).score).toBe(100);
    });

    it('smartMoneyCount >= 10 adds 5 and kolCount >= 10 adds 5, independently, below the clamp', () => {
      const base = neutralToken({ washTrading: true }); // 100 - 20 = 80
      expect(assess(base).score).toBe(80);
      expect(assess({ ...base, smartMoneyCount: 10 }).score).toBe(85);
      expect(assess({ ...base, kolCount: 10 }).score).toBe(85);
      expect(assess({ ...base, smartMoneyCount: 10, kolCount: 10 }).score).toBe(90);
      expect(assess({ ...base, smartMoneyCount: 9 }).score).toBe(80); // below threshold — no bonus
    });

    it('clamps at 100 when bonuses would push the raw total above it', () => {
      expect(assess(token()).score).toBe(100); // 100 + 5 + 5 = 110, clamped
    });

    it('clamps at 0 for a maximally bad token', () => {
      const worst = token({
        honeypot: true,
        renounced: false,
        verified: false,
        lpLockedPct: 5,
        sellTaxPct: 50,
        top10Pct: 90,
        devHoldPct: 40,
        washTrading: true,
        rugRatioPct: 80,
        smartMoneyCount: 0,
        kolCount: 0,
      });
      const a = assess(worst);
      expect(a.score).toBe(0);
      expect(a.grade).toBe('danger');
    });
  });
});
