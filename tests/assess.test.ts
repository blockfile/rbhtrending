import { describe, it, expect } from 'vitest';
import { assess } from '../src/checks/assess';
import type { GmgnToken } from '../src/types';

/** A fully "clean" GmgnToken: no security red flags, every proportional penalty at 0,
 * healthy depth counts. */
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
    top10Pct: 18,
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
    devHoldPct: 0,
    rugRatioPct: 0,
    burnPct: 0,
    smartMoneyCount: 12,
    kolCount: 14,
    sniperCount: 0,
    bundlerRatePct: 0,
    entrapmentPct: 20,
    ratTraderPct: 0,
    botDegenPct: 15,
    washTrading: false,
    hotLevel: 3,
    ...overrides,
  };
}

/** Same clean baseline but with the smart-money/KOL bonuses zeroed out, so score deltas below
 * can be asserted exactly from the 88 baseline without any bonus on top. */
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

    it('scores the 88 baseline plus depth bonuses (smart 12 → +4, KOL 14 → +3)', () => {
      expect(assess(token()).score).toBe(95);
    });

    it('scores exactly the 88 baseline with no smart-money/KOL bonus at all', () => {
      expect(assess(neutralToken()).score).toBe(88);
    });

    it('reaches 100 only with maxed depth bonuses (+7 smart, +5 KOL)', () => {
      expect(assess(token({ smartMoneyCount: 35, kolCount: 30 })).score).toBe(100);
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

    it('botDegenPct > 50 pushes "bots N%", rounded, not at exactly 50', () => {
      expect(assess(token({ botDegenPct: 50 })).flags).toEqual([]);
      expect(assess(token({ botDegenPct: 51 })).flags).toEqual(['bots 51%']);
    });

    it('ratTraderPct > 20 pushes "insiders N%", rounded, not at exactly 20', () => {
      expect(assess(token({ ratTraderPct: 20 })).flags).toEqual([]);
      expect(assess(token({ ratTraderPct: 21 })).flags).toEqual(['insiders 21%']);
    });

    it('sniperCount >= 20 pushes "N snipers", not below', () => {
      expect(assess(token({ sniperCount: 19 })).flags).toEqual([]);
      expect(assess(token({ sniperCount: 20 })).flags).toEqual(['20 snipers']);
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
        botDegenPct: 70,
        ratTraderPct: 40,
        sniperCount: 25,
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
        'bots 70%',
        'insiders 40%',
        '25 snipers',
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

    it('is warn when the score falls below 70 even with no flags at all', () => {
      // rat 10% (-5), bots 40% (-6), entrapment 100% (-10) — none crosses its flag threshold
      const a = assess(neutralToken({ ratTraderPct: 10, botDegenPct: 40, entrapmentPct: 100 }));
      expect(a.flags).toEqual([]);
      expect(a.score).toBe(67);
      expect(a.grade).toBe('warn');
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

    it('a score below 40 forces danger even without a hard security condition', () => {
      // top10 90% (-30 cap) + dev 52% (-20 cap) → 88 - 50 = 38
      const a = assess(neutralToken({ top10Pct: 90, devHoldPct: 52 }));
      expect(a.score).toBe(38);
      expect(a.grade).toBe('danger');
    });
  });

  describe('score — security penalties (fixed)', () => {
    it('honeypot subtracts 80', () => {
      expect(assess(neutralToken({ honeypot: true })).score).toBe(8);
    });

    it('an active (non-renounced) owner subtracts 12', () => {
      expect(assess(neutralToken({ renounced: false })).score).toBe(76);
    });

    it('an unverified contract subtracts 8', () => {
      expect(assess(neutralToken({ verified: false })).score).toBe(80);
    });

    it('LP-lock tiers: <20% subtracts 30, 20-50% subtracts 15, >=50% subtracts nothing', () => {
      expect(assess(neutralToken({ lpLockedPct: 19 })).score).toBe(58);
      expect(assess(neutralToken({ lpLockedPct: 49 })).score).toBe(73);
      expect(assess(neutralToken({ lpLockedPct: 50 })).score).toBe(88);
    });

    it('sell-tax tiers: >30% subtracts 30, >10% subtracts 15, <=10% subtracts nothing', () => {
      expect(assess(neutralToken({ sellTaxPct: 31 })).score).toBe(58);
      expect(assess(neutralToken({ sellTaxPct: 11 })).score).toBe(73);
      expect(assess(neutralToken({ sellTaxPct: 10 })).score).toBe(88);
    });

    it('washTrading subtracts 20', () => {
      expect(assess(neutralToken({ washTrading: true })).score).toBe(68);
    });

    it('rugRatioPct > 50% subtracts 20, not at exactly 50%', () => {
      expect(assess(neutralToken({ rugRatioPct: 51 })).score).toBe(68);
      expect(assess(neutralToken({ rugRatioPct: 50 })).score).toBe(88);
    });
  });

  describe('score — holder-distribution penalties (proportional)', () => {
    it('top10: half a point per % above 20, capped at 30', () => {
      expect(assess(neutralToken({ top10Pct: 20 })).score).toBe(88); // at the free floor
      expect(assess(neutralToken({ top10Pct: 30 })).score).toBe(83); // -5
      expect(assess(neutralToken({ top10Pct: 60 })).score).toBe(68); // -20
      expect(assess(neutralToken({ top10Pct: 90 })).score).toBe(58); // -35 → cap 30
    });

    it('dev hold: 0.6 points per % above 2, capped at 20', () => {
      expect(assess(neutralToken({ devHoldPct: 2 })).score).toBe(88); // at the free floor
      expect(assess(neutralToken({ devHoldPct: 12 })).score).toBe(82); // -6
      expect(assess(neutralToken({ devHoldPct: 22 })).score).toBe(76); // -12
      expect(assess(neutralToken({ devHoldPct: 52 })).score).toBe(68); // -30 → cap 20
    });

    it('a holder base under 100 subtracts 5', () => {
      expect(assess(neutralToken({ holderCount: 99 })).score).toBe(83);
      expect(assess(neutralToken({ holderCount: 100 })).score).toBe(88);
    });
  });

  describe('score — trade-quality penalties (proportional)', () => {
    it('bot traders: 0.3 points per % above 20, capped at 15', () => {
      expect(assess(neutralToken({ botDegenPct: 20 })).score).toBe(88); // at the free floor
      expect(assess(neutralToken({ botDegenPct: 40 })).score).toBe(82); // -6
      expect(assess(neutralToken({ botDegenPct: 90 })).score).toBe(73); // -21 → cap 15
    });

    it('insider (rat-trader) supply: half a point per %, capped at 15', () => {
      expect(assess(neutralToken({ ratTraderPct: 10 })).score).toBe(83); // -5
      expect(assess(neutralToken({ ratTraderPct: 40 })).score).toBe(73); // -20 → cap 15
    });

    it('entrapment: 0.2 points per % above 40, capped at 10', () => {
      expect(assess(neutralToken({ entrapmentPct: 40 })).score).toBe(88); // at the free floor
      expect(assess(neutralToken({ entrapmentPct: 60 })).score).toBe(84); // -4
      expect(assess(neutralToken({ entrapmentPct: 100 })).score).toBe(78); // -12 → cap 10
    });

    it('snipers: a quarter point each, capped at 8', () => {
      expect(assess(neutralToken({ sniperCount: 8 })).score).toBe(86); // -2
      expect(assess(neutralToken({ sniperCount: 40 })).score).toBe(80); // -10 → cap 8
    });

    it('bundled supply: half a point per % above 5, capped at 5', () => {
      expect(assess(neutralToken({ bundlerRatePct: 5 })).score).toBe(88); // at the free floor
      expect(assess(neutralToken({ bundlerRatePct: 15 })).score).toBe(83); // -5
      expect(assess(neutralToken({ bundlerRatePct: 25 })).score).toBe(83); // -10 → cap 5
    });
  });

  describe('score — depth bonuses (graduated)', () => {
    it('smart money adds 0.3 per wallet, capped at 7', () => {
      expect(assess(neutralToken({ smartMoneyCount: 10 })).score).toBe(91); // +3
      expect(assess(neutralToken({ smartMoneyCount: 30 })).score).toBe(95); // +9 → cap 7
    });

    it('KOLs add 0.2 per wallet, capped at 5', () => {
      expect(assess(neutralToken({ kolCount: 10 })).score).toBe(90); // +2
      expect(assess(neutralToken({ kolCount: 30 })).score).toBe(93); // +6 → cap 5
    });

    it('bonuses cannot mask penalties past 100', () => {
      // max bonuses (+12) on the clean 88 baseline land exactly at 100, never above
      expect(assess(neutralToken({ smartMoneyCount: 100, kolCount: 100 })).score).toBe(100);
    });
  });

  describe('score — clamping', () => {
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
