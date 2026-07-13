import { describe, it, expect } from 'vitest';
import {
  escapeHtml, formatCard, formatFollowUp, buildButtons, tokenImageUrl, Telegram, ageStr,
  type FollowUpData,
} from '../src/telegram';
import { assess } from '../src/checks/assess';
import type { GmgnToken, ButtonsConfig } from '../src/types';

// ---------------------------------------------------------------------------
// buildButtons
// ---------------------------------------------------------------------------

const ADDR = '0xCA00000000000000000000000000000000CAFE';
const BTN_CFG: ButtonsConfig = { chart: true, scan: true, trade: true };

describe('buildButtons', () => {
  it('builds a Chart/Scan/Trade row plus a Copy-CA row (copy_text works on mobile where tapping <code> may not)', () => {
    const kb = buildButtons(ADDR, BTN_CFG);
    expect(kb).toHaveLength(2);
    expect(kb[0]).toEqual([
      { text: '📊 Chart', url: `https://gmgn.ai/robinhood/token/${ADDR}` },
      { text: '🔍 Scan', url: `https://robinhoodchain.blockscout.com/token/${ADDR}` },
      { text: '💱 Trade', url: `https://gmgn.ai/robinhood/token/${ADDR}?tab=trade` },
    ]);
    expect(kb[1]).toEqual([{ text: '📋 Copy CA', copy_text: { text: ADDR } }]);
  });

  it('honors the include whitelist (for follow-ups) and disabled flags', () => {
    const kb = buildButtons(ADDR, BTN_CFG, { include: ['chart', 'trade'] });
    expect(kb[0].map((b) => b.text)).toEqual(['📊 Chart', '💱 Trade']);
    const off = buildButtons(ADDR, { chart: false, scan: false, trade: false });
    expect(off).toEqual([[{ text: '📋 Copy CA', copy_text: { text: ADDR } }]]); // copy row survives alone
  });
});

// ---------------------------------------------------------------------------
// tokenImageUrl
// ---------------------------------------------------------------------------

describe('tokenImageUrl', () => {
  it('proxies the GMGN logo through weserv when a logo is present (GMGN 403s Telegram, weserv passes)', () => {
    expect(tokenImageUrl(ADDR, 'https://gmgn.ai/external-res/abc_v2.webp')).toBe(
      'https://images.weserv.nl/?url=https%3A%2F%2Fgmgn.ai%2Fexternal-res%2Fabc_v2.webp',
    );
  });

  it('falls back to the DexScreener token-image CDN (lowercased address) when there is no logo', () => {
    expect(tokenImageUrl(ADDR)).toBe(
      'https://dd.dexscreener.com/ds-data/tokens/robinhood/0xca00000000000000000000000000000000cafe.png',
    );
  });
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  it('escapes &, <, >', () => {
    expect(escapeHtml('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });
});

// ---------------------------------------------------------------------------
// formatCard
// ---------------------------------------------------------------------------

const TOKEN: GmgnToken = {
  address: '0xTOKEN000000000000000000000000000000001',
  name: 'Cool <Token>',
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
  entrapmentPct: 20,
  ratTraderPct: 0,
  botDegenPct: 15,
  washTrading: false,
  hotLevel: 3,
};

describe('ageStr', () => {
  const now = 1_700_000_000_000;

  it('formats under 60 minutes as "{n}m"', () => {
    expect(ageStr(now - 5 * 60_000, now)).toBe('5m');
    expect(ageStr(now - 59 * 60_000, now)).toBe('59m');
  });

  it('formats 60 minutes up to 1440 minutes as "{n}h"', () => {
    expect(ageStr(now - 60 * 60_000, now)).toBe('1h'); // exact 60m boundary rolls to hours
    expect(ageStr(now - 23 * 60 * 60_000, now)).toBe('23h');
  });

  it('formats 1440 minutes and beyond as "{n}d"', () => {
    expect(ageStr(now - 1440 * 60_000, now)).toBe('1d'); // exact 1440m boundary rolls to days
    expect(ageStr(now - 3 * 1440 * 60_000, now)).toBe('3d');
  });

  it('returns undefined for 0/absent createdAt so the caller can omit the segment', () => {
    expect(ageStr(0, now)).toBeUndefined();
  });
});

describe('formatCard', () => {
  it('renders the full card: header, age/security/score line, links, market/distribution/security blocks, and tap-copy contract', () => {
    const a = assess(TOKEN);
    const text = formatCard(TOKEN, a);
    expect(text).toContain('🔥 <b>$HOOD</b> • Cool &lt;Token&gt; — New Trending');
    // 88 baseline -1 top10(21%) -2 dev(5%) -1 snipers(3) +4 smart(12) +3 KOL(14) = 91
    expect(text).toMatch(/🕐 Age: \d+[mhd] \| Security: ✅ \| ⭐ 91\/100/);
    expect(text).toContain(
      '🔗 <a href="https://x.com/dev">X</a> • <a href="https://t.me/c">TG</a>'
      + ' • <a href="https://gmgn.ai/robinhood/token/0xTOKEN000000000000000000000000000000001">CHART</a>',
    );
    expect(text).toContain('💰 MC: $184.0k • 🔝 ATH: $240.0k');
    expect(text).toContain('💧 Liq: $12.3k');
    expect(text).toContain('📈 Vol 1h: $27.6k');
    expect(text).toContain('└ Swaps: 512 | Buys: 41');
    expect(text).toContain('👥 Holders: 341');
    expect(text).toContain('🎯 Top 10: 21% | 🛠 Dev: 5%');
    expect(text).toContain('├ 📦 Bundled: 0% | 🐍 Snipers: 3');
    expect(text).toContain('├ 🤖 Bots: 15% | 🐀 Insiders: 0%');
    expect(text).toContain('└ 🧠 Smart: 12 | 👑 KOL: 14');
    expect(text).toContain('🛡 Honeypot ❌ | Tax 0/0%');
    expect(text).toContain('└ LP 🔒 95% | Renounced ✅ | Verified ✅');
    expect(text).toContain('<code>0xTOKEN000000000000000000000000000000001</code>');
    expect(text).not.toContain('⚠️'); // clean fixture — no flags line
  });

  it('drops the Age segment (keeping Security and score) when createdAt is 0/absent', () => {
    const a = assess(TOKEN);
    const text = formatCard({ ...TOKEN, createdAt: 0 }, a);
    expect(text).toContain('🛡 Security: ✅ | ⭐ 91/100');
    expect(text).not.toContain('Age:');
  });

  it('links only the socials that exist (CHART is always last)', () => {
    const webOnly = { ...TOKEN, twitter: undefined, telegram: undefined, website: 'https://hood.fun' };
    const text = formatCard(webOnly, assess(webOnly));
    expect(text).toContain(
      '🔗 <a href="https://hood.fun">WEB</a>'
      + ' • <a href="https://gmgn.ai/robinhood/token/0xTOKEN000000000000000000000000000000001">CHART</a>',
    );
    const none = { ...TOKEN, twitter: undefined, telegram: undefined, website: undefined };
    expect(formatCard(none, assess(none))).toContain(
      '🔗 <a href="https://gmgn.ai/robinhood/token/0xTOKEN000000000000000000000000000000001">CHART</a>',
    );
  });

  it('never shows an ATH below current MC (clamps ATH to >= MC)', () => {
    const t = { ...TOKEN, marketCapUsd: 530000, athMarketCapUsd: 418000 };
    const text = formatCard(t, assess(t));
    expect(text).toContain('💰 MC: $530.0k • 🔝 ATH: $530.0k');
  });

  it('renders a honeypot/flagged token with a 🧨 header, an ⚠️ flags line under the links, and Honeypot 🧨', () => {
    const flagged: GmgnToken = {
      ...TOKEN,
      honeypot: true,
      sellTaxPct: 15,
      lpLockedPct: 30,
      renounced: false,
      verified: false,
      top10Pct: 60,
      devHoldPct: 20,
      washTrading: true,
    };
    const a = assess(flagged);
    expect(a.grade).toBe('danger');
    const text = formatCard(flagged, a);
    expect(text.startsWith('🧨')).toBe(true);
    expect(text).toContain(`⚠️ ${a.flags.join(' · ')}`);
    expect(text).toContain('Security: 🧨');
    expect(text).toContain('🛡 Honeypot 🧨 | Tax 0/15%');
    // the flags line sits directly under the links line, before the market block
    const lines = text.split('\n');
    expect(lines.findIndex((l) => l.startsWith('⚠️'))).toBe(lines.findIndex((l) => l.startsWith('🔗')) + 1);
  });

  it('renders a warn-grade token (a single non-danger flag) with an ⚠️ header and matching flags line', () => {
    const warnToken: GmgnToken = { ...TOKEN, devHoldPct: 20 }; // only "dev holds 20%" — not a danger condition
    const a = assess(warnToken);
    expect(a.grade).toBe('warn');
    const text = formatCard(warnToken, a);
    expect(text.startsWith('⚠️')).toBe(true);
    expect(text).toContain('⚠️ dev holds 20%');
    expect(text).toContain('Security: ⚠️');
  });

  it('shows no ⚠️ flags line for a fully clean token', () => {
    expect(formatCard(TOKEN, assess(TOKEN))).not.toContain('⚠️');
  });

  it('renders the LP lock emoji 🔒 at/above 50% and 🔓 below it', () => {
    expect(formatCard(TOKEN, assess(TOKEN))).toContain('LP 🔒 95%');
    const unlocked = { ...TOKEN, lpLockedPct: 30 };
    expect(formatCard(unlocked, assess(unlocked))).toContain('LP 🔓 30%');
  });

  it('abbreviates large USD values with M/B suffixes', () => {
    const big = { ...TOKEN, marketCapUsd: 156176100, liquidityUsd: 10527600 };
    const bigText = formatCard(big, assess(big));
    expect(bigText).toContain('💰 MC: $156.2M');
    expect(bigText).toContain('💧 Liq: $10.5M');
    const huge = { ...TOKEN, marketCapUsd: 2_400_000_000 };
    expect(formatCard(huge, assess(huge))).toContain('💰 MC: $2.4B');
  });

  it('places blank lines exactly before the market, distribution, and security blocks and the contract line', () => {
    const lines = formatCard(TOKEN, assess(TOKEN)).split('\n');
    const mcIdx = lines.findIndex((l) => l.startsWith('💰 MC:'));
    const distIdx = lines.findIndex((l) => l.startsWith('🎯 Top 10:'));
    const secIdx = lines.findIndex((l) => l.startsWith('🛡 Honeypot'));
    const codeIdx = lines.findIndex((l) => l.startsWith('<code>'));
    expect(lines[mcIdx - 1]).toBe('');
    expect(lines[distIdx - 1]).toBe('');
    expect(lines[secIdx - 1]).toBe('');
    expect(lines[codeIdx - 1]).toBe('');
  });
});

// ---------------------------------------------------------------------------
// formatFollowUp
// ---------------------------------------------------------------------------

describe('formatFollowUp', () => {
  it('renders an up-Nx card with the multiple, move, rockets, and contract line', () => {
    const d: FollowUpData = { kind: 'up', symbol: 'HOOD', address: '0xTOKEN1', multiple: 5, fromUsd: 39600, peakUsd: 198000 };
    const s = formatFollowUp(d);
    expect(s).toContain('$HOOD</b> is up 5X');
    expect(s).toContain('$39.6k → $198.0k');
    expect(s).toContain('🚀🚀🚀🚀🚀');
    expect(s).toContain('<code>0xTOKEN1</code>');
  });

  it('caps the rocket row at 10', () => {
    const s = formatFollowUp({ kind: 'up', symbol: 'X', address: '0xA', multiple: 100, fromUsd: 1000, peakUsd: 100000 });
    expect(s).toContain('is up 100X');
    expect((s.match(/🚀/g) ?? []).length).toBe(10);
  });

  it('renders a window recap with peak and current performance', () => {
    const s = formatFollowUp({ kind: 'window', symbol: 'COOL', address: '0xB', peakUsd: 22000, nowUsd: 9000, peakPct: 47, nowPct: -40 });
    expect(s).toContain('$COOL');
    expect(s).toContain('peaked $22.0k (+47%)');
    expect(s).toContain('now $9.0k (-40% since alert)');
    expect(s).not.toContain('⚠️');
  });

  it('leads dump follow-ups with a warning', () => {
    const s = formatFollowUp({ kind: 'dump', symbol: 'RUG', address: '0xC', peakUsd: 30000, nowUsd: 6000, peakPct: 100, nowPct: -80 });
    expect(s).toContain('⚠️');
    expect(s).toContain('dumped from peak');
  });
});

// ---------------------------------------------------------------------------
// Telegram (ported from the Solana repo — chain-agnostic, unchanged behavior)
// ---------------------------------------------------------------------------

describe('Telegram', () => {
  it('posts to the bot API and returns true on ok', async () => {
    let captured: { url: string; body: string } | null = null;
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(url), body: String(init?.body) };
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await new Telegram('TOKEN', '42', f).send('hello');
    expect(r.ok).toBe(true);
    expect(captured!.url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    const body = JSON.parse(captured!.body);
    expect(body).toMatchObject({ chat_id: '42', text: 'hello', parse_mode: 'HTML' });
  });

  it('returns false after 3 failures without throwing', async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response('err', { status: 400 }); }) as unknown as typeof fetch;
    expect((await new Telegram('T', '1', f).send('x')).ok).toBe(false);
    expect(calls).toBe(3);
  });

  it('sends a photo card with caption and inline buttons', async () => {
    const captured: Array<{ url: string; body: any }> = [];
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{"ok":true,"result":{"message_id":777}}', { status: 200 });
    }) as unknown as typeof fetch;
    const buttons = [[{ text: 'Chart', url: 'https://c' }]];
    const r = await new Telegram('T', '42', f).send({ text: 'cap', photoUrl: 'https://img', buttons });
    expect(r).toMatchObject({ ok: true, messageId: 777, photo: true });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('https://api.telegram.org/botT/sendPhoto');
    expect(captured[0].body).toMatchObject({
      chat_id: '42', photo: 'https://img', caption: 'cap', parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons },
    });
  });

  it('falls back to a text message when the photo cannot be sent', async () => {
    const urls: string[] = [];
    const f = (async (url: RequestInfo | URL) => {
      const u = String(url);
      urls.push(u);
      return u.endsWith('/sendPhoto')
        ? new Response('{"ok":false,"description":"wrong file"}', { status: 400 })
        : new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await new Telegram('T', '1', f).send({ text: 'cap', photoUrl: 'https://bad' });
    expect(r.ok).toBe(true);
    expect(r.photo).toBe(false);
    expect(urls.some((u) => u.endsWith('/sendPhoto'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/sendMessage'))).toBe(true);
  });

  it('waits out a 429 using retry_after then succeeds', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      if (calls === 1) {
        return new Response('{"ok":false,"parameters":{"retry_after":0}}', { status: 429 });
      }
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const start = Date.now();
    const r = await new Telegram('T', '1', f).send('x');
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
  }, 10_000);

  it('editCaption edits a photo card via editMessageCaption and resends the buttons', async () => {
    const captured: Array<{ url: string; body: any }> = [];
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const buttons = [[{ text: 'Chart', url: 'https://c' }]];
    const ok = await new Telegram('T', '42', f).editCaption(777, 'updated', buttons, true);
    expect(ok).toBe(true);
    expect(captured[0].url).toBe('https://api.telegram.org/botT/editMessageCaption');
    expect(captured[0].body).toMatchObject({
      chat_id: '42', message_id: 777, caption: 'updated', parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons },
    });
  });

  it('editCaption edits a text card via editMessageText', async () => {
    let url = '';
    const f = (async (u: RequestInfo | URL) => { url = String(u); return new Response('{"ok":true}', { status: 200 }); }) as unknown as typeof fetch;
    expect(await new Telegram('T', '1', f).editCaption(5, 'x', [], false)).toBe(true);
    expect(url).toBe('https://api.telegram.org/botT/editMessageText');
  });

  it("editCaption treats 'message is not modified' as success and does not retry", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response('{"ok":false,"description":"Bad Request: message is not modified"}', { status: 400 });
    }) as unknown as typeof fetch;
    expect(await new Telegram('T', '1', f).editCaption(5, 'same', [], true)).toBe(true);
    expect(calls).toBe(1);
  });
});
