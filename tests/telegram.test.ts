import { describe, it, expect } from 'vitest';
import {
  escapeHtml, formatCard, formatFollowUp, buildButtons, Telegram,
  type FollowUpData,
} from '../src/telegram';
import type { TokenCard, ButtonsConfig } from '../src/types';

// ---------------------------------------------------------------------------
// buildButtons
// ---------------------------------------------------------------------------

const CARD_ADDR = {
  address: '0xCA00000000000000000000000000000000CAFE',
  poolAddress: '0xP0000000000000000000000000000000000001',
};
const BTN_CFG: ButtonsConfig = { chart: true, scan: true, trade: true };

describe('buildButtons', () => {
  it('builds a single Chart/Scan/Trade row, substituting the token address and pool address', () => {
    const kb = buildButtons(CARD_ADDR, BTN_CFG);
    expect(kb).toHaveLength(1);
    expect(kb[0]).toEqual([
      { text: '📊 Chart', url: `https://www.geckoterminal.com/robinhood/pools/${CARD_ADDR.poolAddress}` },
      { text: '🔍 Scan', url: `https://robinhoodchain.blockscout.com/token/${CARD_ADDR.address}` },
      { text: '💱 Trade', url: `https://dexscreener.com/robinhood/${CARD_ADDR.poolAddress}` },
    ]);
  });

  it('honors the include whitelist (for follow-ups) and disabled flags', () => {
    const kb = buildButtons(CARD_ADDR, BTN_CFG, { include: ['chart', 'trade'] });
    expect(kb[0].map((b) => b.text)).toEqual(['📊 Chart', '💱 Trade']);
    const off = buildButtons(CARD_ADDR, { chart: false, scan: false, trade: false });
    expect(off).toEqual([]);
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

const CARD: TokenCard = {
  address: '0xTOKEN000000000000000000000000000000001',
  symbol: 'HOOD',
  name: 'Cool <Token>',
  liquidityUsd: 12300,
  volume1hUsd: 27600,
  buyers1h: 41,
  priceUsd: 0.0042,
  fdvUsd: 184000,
  poolAddress: '0xPOOL0000000000000000000000000000000001',
  createdAt: 1752300000000,
  security: {
    sellTaxPct: 2,
    topHolderPct: 21,
    riskLevel: 'safe',
    honeypot: false,
    buyTaxPct: 2,
    lpBurnedOrLocked: true,
    ownerRenounced: true,
    verified: true,
    transferable: true,
  },
  athUsd: 240000,
  holders: 341,
  fakeVolumePct: 12,
  gtScore: 91,
  twitter: 'https://x.com/dev',
  telegram: 'https://t.me/c',
  website: undefined,
};

describe('formatCard', () => {
  it('renders the full card with escaped name, security detail, market data, and tap-copy contract', () => {
    const text = formatCard(CARD);
    expect(text).toContain('🔥 <b>$HOOD</b> • Cool &lt;Token&gt;');
    expect(text).toContain('🛡 Security: ✅  renounced ✅ · LP 🔒 · verified ✅ · transfers ✅ · honeypot n/a');
    expect(text).toContain('🏅 Trust: 91/100 (GeckoTerminal)');
    expect(text).toContain('💰 MC: $184.0k · 💧 Liq: $12.3k');
    expect(text).toContain('📊 Vol 1h: $27.6k • 🪙 fake ~12%');
    expect(text).toContain('🏆 Top 10 holders: 21%');
    expect(text).toContain('🐦 X ✅ | TG ✅ | Web ❌');
    expect(text).toContain('<code>0xTOKEN000000000000000000000000000000001</code>');
    expect(text).not.toContain('📈 Now:'); // no live line unless c.live is present
    expect(text).not.toContain('ATH'); // removed entirely — ATH data isn't available (Option-A)
    expect(text).not.toContain('👥 Holders'); // removed entirely — holders count isn't available
    expect(text).not.toContain('not measured');
  });

  it('hides the Trust line when gtScore is absent', () => {
    const text = formatCard({ ...CARD, gtScore: undefined });
    expect(text).not.toContain('Trust');
  });

  it('hides the Top 10 holders line when security.topHolderPct is unknown/absent', () => {
    const unknown = formatCard({ ...CARD, security: { ...CARD.security!, topHolderPct: 'unknown' } });
    expect(unknown).not.toContain('Top 10 holders');

    const noSecurity = formatCard({ ...CARD, security: undefined });
    expect(noSecurity).not.toContain('Top 10 holders');
  });

  it('renders the live Now line only when c.live is present', () => {
    const withLive = formatCard({ ...CARD, live: { nowUsd: 48200, multiple: 3.1 } });
    expect(withLive).toContain('📈 Now: $48.2k • 3.1X');
    expect(formatCard(CARD)).not.toContain('📈 Now:');
  });

  it('abbreviates large USD values with M/B suffixes', () => {
    const big = formatCard({ ...CARD, fdvUsd: 156176100, liquidityUsd: 10527600 });
    expect(big).toContain('💰 MC: $156.2M · 💧 Liq: $10.5M');
    const huge = formatCard({ ...CARD, fdvUsd: 2_400_000_000 });
    expect(huge).toContain('💰 MC: $2.4B');
  });

  it('picks the grade emoji and security badge from the four risk tiers', () => {
    const safe = formatCard({ ...CARD, security: { ...CARD.security!, riskLevel: 'safe' } });
    expect(safe.startsWith('🔥')).toBe(true);
    expect(safe).toContain('🛡 Security: ✅');

    const warn = formatCard({ ...CARD, security: { ...CARD.security!, riskLevel: 'warn' } });
    expect(warn.startsWith('⚠️')).toBe(true);
    expect(warn).toContain('🛡 Security: ⚠️  renounced');

    const danger = formatCard({ ...CARD, security: { ...CARD.security!, riskLevel: 'danger' } });
    expect(danger.startsWith('🧨')).toBe(true);
    expect(danger).toContain('🛡 Security: 🧨');

    const unknown = formatCard({ ...CARD, security: { ...CARD.security!, riskLevel: 'unknown' } });
    expect(unknown).toContain('🛡 Security: ❓');
  });

  it('treats an unknown/missing risk level as ❓ and never upgrades toward safe', () => {
    const unknownRisk = formatCard({ ...CARD, security: { ...CARD.security!, riskLevel: 'unknown' } });
    expect(unknownRisk.startsWith('⚠️')).toBe(true);
    expect(unknownRisk).toContain('🛡 Security: ❓');

    const noSecurity = formatCard({ ...CARD, security: undefined });
    expect(noSecurity.startsWith('⚠️')).toBe(true);
    expect(noSecurity).toContain('🛡 Security: ❓');
  });

  it('renders unknown/absent security sub-fields as ?, with honeypot always "n/a", and hides the Top 10 line', () => {
    const text = formatCard({
      ...CARD,
      security: { sellTaxPct: 'unknown', topHolderPct: 'unknown', riskLevel: 'warn' },
    });
    expect(text).toContain('🛡 Security: ⚠️  renounced ? · LP ? · verified ? · transfers ? · honeypot n/a');
    expect(text).not.toContain('Top 10 holders');
  });

  it('renders LP/verified/transfers as ❌ (not the old ⚠️) when explicitly false', () => {
    const text = formatCard({
      ...CARD,
      security: {
        ...CARD.security!,
        lpBurnedOrLocked: false,
        verified: false,
        transferable: false,
        ownerRenounced: false,
        riskLevel: 'danger',
      },
    });
    expect(text).toContain('🛡 Security: 🧨  renounced ❌ · LP ❌ · verified ❌ · transfers ❌ · honeypot n/a');
  });

  it('renders unknown/absent display fields as ? (MC, Liq, Vol) and never shows ATH/Holders', () => {
    const text = formatCard({
      ...CARD,
      fdvUsd: 'unknown', athUsd: 'unknown', liquidityUsd: 'unknown',
      volume1hUsd: 'unknown', holders: 'unknown',
    });
    expect(text).toContain('💰 MC: ? · 💧 Liq: ?');
    expect(text).toContain('📊 Vol 1h: ?');
    expect(text).not.toContain('ATH');
    expect(text).not.toContain('Holders');
  });

  it('omits the fake-volume segment when fakeVolumePct is unknown or absent, shows it when known', () => {
    const unknown = formatCard({ ...CARD, fakeVolumePct: 'unknown' });
    expect(unknown).toContain('📊 Vol 1h: $27.6k');
    expect(unknown).not.toContain('fake');

    const absent = formatCard({ ...CARD, fakeVolumePct: undefined });
    expect(absent).not.toContain('fake');

    const known = formatCard({ ...CARD, fakeVolumePct: 5 });
    expect(known).toContain('📊 Vol 1h: $27.6k • 🪙 fake ~5%');
  });

  it('marks socials ❌ when absent', () => {
    const text = formatCard({ ...CARD, twitter: undefined, telegram: undefined, website: 'https://hood.fun' });
    expect(text).toContain('🐦 X ❌ | TG ❌ | Web ✅');
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
