import type { ButtonsConfig, GmgnToken } from './types';
import type { Assessment } from './checks/assess';
import { log } from './logger';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export type InlineButton =
  | { text: string; url: string }
  | { text: string; copy_text: { text: string } }; // Bot API 7.11+ tap-to-copy button
export type Keyboard = InlineButton[][];

export interface SendResult {
  ok: boolean;
  messageId?: number;
  photo?: boolean;
}

// --- Robinhood Chain link targets ------------------------------------------------------
// GMGN is a full trading terminal for this chain — Chart and Trade both point there.
// Blockscout base — confirmed live at robinhoodchain.blockscout.com.
export const GMGN_TOKEN_BASE = 'https://gmgn.ai/robinhood/token';
const BLOCKSCOUT_BASE = 'https://robinhoodchain.blockscout.com';

// GMGN's own logo URLs (gmgn.ai/external-res/…) sit behind a Cloudflare JS challenge that 403s
// every non-browser client — including Telegram's server-side sendPhoto fetcher — so cards sent
// with them directly always degrade to text. The weserv.nl image proxy DOES get through that
// challenge, and GMGN sends a logo for essentially every row, so it's the primary source.
// DexScreener's public CDN covers logo-less rows, but misses many young (<6h) tokens — the ones
// most likely to alert — which is why it's only the fallback.
const WESERV_PROXY = 'https://images.weserv.nl/';
const DEXSCREENER_IMG_BASE = 'https://dd.dexscreener.com/ds-data/tokens/robinhood';

/** Card-photo URL Telegram can actually fetch: weserv-proxied GMGN logo when the row has one,
 * else the DexScreener CDN image. Either can still 404 → Telegram.send's existing text fallback. */
export function tokenImageUrl(address: string, logo?: string): string {
  if (logo) return `${WESERV_PROXY}?url=${encodeURIComponent(logo)}`;
  return `${DEXSCREENER_IMG_BASE}/${address.toLowerCase()}.png`;
}

const WEB_BUTTONS: Record<'chart' | 'scan' | 'trade', { text: string; url: (address: string) => string }> = {
  chart: { text: '📊 Chart', url: (address) => `${GMGN_TOKEN_BASE}/${address}` },
  scan: { text: '🔍 Scan', url: (address) => `${BLOCKSCOUT_BASE}/token/${address}` },
  trade: { text: '💱 Trade', url: (address) => `${GMGN_TOKEN_BASE}/${address}?tab=trade` },
};

/** Build the inline keyboard for a token: a Chart / Scan / Trade row gated by config, plus an
 * always-on Copy-CA row — a `copy_text` button copies on tap in every official client, where
 * tapping the card's `<code>` address does not reliably copy on mobile. */
export function buildButtons(
  address: string,
  cfg: ButtonsConfig,
  opts: { include?: Array<'chart' | 'scan' | 'trade'> } = {},
): Keyboard {
  const keys = opts.include ?? (['chart', 'scan', 'trade'] as const);
  const row = keys
    .filter((k) => cfg[k])
    .map((k) => ({ text: WEB_BUTTONS[k].text, url: WEB_BUTTONS[k].url(address) }));
  const rows: Keyboard = row.length ? [row] : [];
  rows.push([{ text: '📋 Copy CA', copy_text: { text: address } }]);
  return rows;
}

// --- Card formatting ---------------------------------------------------------------------

export function usdOrQ(v: number | 'unknown' | undefined): string {
  if (v === undefined || v === 'unknown') return '?';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

/**
 * Compact age from a unix-ms `createdAt`: "{n}m" under 60 minutes, "{n}h" under 1440 minutes
 * (24h), else "{n}d". Returns `undefined` for a falsy `createdAt` (0/absent — unknown age) so
 * the caller can omit the segment entirely. `now` is a param (rather than reading `Date.now()`
 * internally) so this is directly unit-testable at fixed times.
 */
export function ageStr(createdAt: number, now: number): string | undefined {
  if (!createdAt) return undefined;
  const minutes = Math.max(0, Math.floor((now - createdAt) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

const GRADE: Record<'safe' | 'warn' | 'danger' | 'unknown', string> = {
  safe: '🔥', warn: '⚠️', danger: '🧨', unknown: '⚠️',
};
const SECURITY_EMOJI: Record<'safe' | 'warn' | 'danger' | 'unknown', string> = {
  safe: '✅', warn: '⚠️', danger: '🧨', unknown: '❓',
};

/**
 * Render a `GmgnToken` + its `assess()` verdict as the Telegram HTML card body, arranged like
 * the Solana "Early Trending" reference cards: header + Age/Security/score line + social links,
 * then market / holder-distribution / security blocks with └├ tree connectors. Every GMGN field
 * is a concrete number/boolean (never 'unknown'), so there's no '?' placeholder handling here.
 * The ⚠️ flags line (under the links) and the `Age:` segment are each omitted entirely when not
 * applicable (no flags; createdAt is 0/absent).
 */
export function formatCard(t: GmgnToken, a: Assessment): string {
  const grade = GRADE[a.grade];
  const securityBadge = SECURITY_EMOJI[a.grade];

  const age = ageStr(t.createdAt, Date.now());
  const statusLine = age
    ? `🕐 Age: ${age} | Security: ${securityBadge} | ⭐ ${a.score}/100`
    : `🛡 Security: ${securityBadge} | ⭐ ${a.score}/100`;

  const links: string[] = [];
  if (t.twitter) links.push(`<a href="${escapeHtml(t.twitter)}">X</a>`);
  if (t.telegram) links.push(`<a href="${escapeHtml(t.telegram)}">TG</a>`);
  if (t.website) links.push(`<a href="${escapeHtml(t.website)}">WEB</a>`);
  links.push(`<a href="${GMGN_TOKEN_BASE}/${t.address}">CHART</a>`);

  const lines = [
    `${grade} <b>$${escapeHtml(t.symbol)}</b> • ${escapeHtml(t.name)} — New Trending`,
    statusLine,
    `🔗 ${links.join(' • ')}`,
  ];

  if (a.flags.length) lines.push(`⚠️ ${a.flags.map(escapeHtml).join(' · ')}`);

  lines.push(
    '',
    `💰 MC: ${usdOrQ(t.marketCapUsd)} • 🔝 ATH: ${usdOrQ(Math.max(t.marketCapUsd, t.athMarketCapUsd))}`,
    `💧 Liq: ${usdOrQ(t.liquidityUsd)}`,
    `📈 Vol 1h: ${usdOrQ(t.volumeUsd)}`,
    `└ Swaps: ${t.swaps} | Buys: ${t.buys}`,
    `👥 Holders: ${t.holderCount}`,
    '',
    `🎯 Top 10: ${t.top10Pct.toFixed(0)}% | 🛠 Dev: ${t.devHoldPct.toFixed(0)}%`,
    `├ 📦 Bundled: ${t.bundlerRatePct.toFixed(0)}% | 🐍 Snipers: ${t.sniperCount}`,
    `├ 🤖 Bots: ${t.botDegenPct.toFixed(0)}% | 🐀 Insiders: ${t.ratTraderPct.toFixed(0)}%`,
    `└ 🧠 Smart: ${t.smartMoneyCount} | 👑 KOL: ${t.kolCount}`,
    '',
    `🛡 Honeypot ${t.honeypot ? '🧨' : '❌'} | Tax ${t.buyTaxPct.toFixed(0)}/${t.sellTaxPct.toFixed(0)}%`,
    `└ LP ${t.lpLockedPct >= 50 ? '🔒' : '🔓'} ${t.lpLockedPct.toFixed(0)}% | Renounced ${t.renounced ? '✅' : '❌'} | Verified ${t.verified ? '✅' : '❌'}`,
    '',
    `<code>${t.address}</code>`, // tap to copy on desktop — the 📋 Copy CA button covers mobile
  );
  return lines.join('\n');
}

export interface PromoCardResult {
  text: string;
  photoUrl?: string;
  buttons: Keyboard;
}

/** Inline keyboard for a promoted post: a prominent 🚀 Buy (GMGN trade), then Chart / Scan, then
 * a tap-to-copy contract-address button. */
function promoButtons(address: string): Keyboard {
  return [
    [{ text: '🚀 Buy', url: `${GMGN_TOKEN_BASE}/${address}?tab=trade` }],
    [{ text: '📊 Chart', url: `${GMGN_TOKEN_BASE}/${address}` }, { text: '🔍 Scan', url: `${BLOCKSCOUT_BASE}/token/${address}` }],
    [{ text: '📋 Copy CA', copy_text: { text: address } }],
  ];
}

/**
 * Render a paid ⭐ slot's promoted post. With live token data it's a full trending-style photo
 * card (logo + the same stats block as an alert) under a `⭐ PROMOTED · #rank · time-left`
 * banner; without it (token not in the current feed) it falls back to a compact text card so a
 * bump never fails. Always carries the 🚀 Buy keyboard. `hoursLeft` is precomputed by the caller
 * (so this stays pure/testable). The ⭐ PROMOTED label is always shown — paid slots are disclosed.
 */
export function formatPromoCard(args: {
  symbol: string;
  address: string;
  rank: number;
  hoursLeft: number;
  token?: GmgnToken;
  assessment?: Assessment;
}): PromoCardResult {
  const { symbol, address, rank, hoursLeft, token, assessment } = args;
  const banner = `⭐ <b>PROMOTED</b> · #${rank} · ⏳ ${Math.max(0, hoursLeft)}h left`;
  const buttons = promoButtons(address);

  if (token && assessment) {
    return {
      text: `${banner}\n${formatCard(token, assessment)}`,
      photoUrl: tokenImageUrl(token.address, token.logo),
      buttons,
    };
  }

  const text = [
    banner,
    `<b>$${escapeHtml(symbol)}</b> — holding #${rank} on the trending board`,
    '',
    `<code>${address}</code>`,
  ].join('\n');
  return { text, buttons };
}

export type FollowUpData =
  | { kind: 'up'; symbol: string; address: string; multiple: number; fromUsd: number; peakUsd: number }
  | { kind: 'dump' | 'window'; symbol: string; address: string; peakUsd: number; nowUsd: number; peakPct: number; nowPct: number };

export function formatFollowUp(d: FollowUpData): string {
  const k = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`);
  const sign = (n: number) => (n >= 0 ? `+${n.toFixed(0)}` : n.toFixed(0));
  if (d.kind === 'up') {
    const lines = [
      `📈 <b>$${escapeHtml(d.symbol)}</b> is up ${d.multiple}X 📈`,
      'from your trending alert',
      `${k(d.fromUsd)} → ${k(d.peakUsd)}`,
      '🚀'.repeat(Math.min(d.multiple, 10)),
      '',
      `<code>${d.address}</code>`,
    ];
    return lines.join('\n');
  }
  const head = d.kind === 'dump' ? '⚠️ ' : '📊 ';
  const verb = d.kind === 'dump' ? 'dumped from peak' : 'recap';
  return `${head}<b>$${escapeHtml(d.symbol)}</b> ${verb} — peaked ${k(d.peakUsd)} (${sign(d.peakPct)}%), now ${k(d.nowUsd)} (${sign(d.nowPct)}% since alert)`;
}

// --- Telegram client (verbatim from the Solana repo — chain-agnostic) --------------------

export class Telegram {
  constructor(
    private botToken: string,
    private chatId: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  /**
   * Send a message to the configured channel. A plain string sends text; a payload with
   * `photoUrl` sends an image card (caption + buttons) and, if Telegram can't fetch the image,
   * falls back to a text message so an alert is never lost to a bad image URL.
   * Returns the delivered message's id so the caller can live-edit it later.
   */
  async send(payload: string | { text: string; photoUrl?: string; buttons?: Keyboard }): Promise<SendResult> {
    return this.sendTo(this.chatId, payload);
  }

  /** Same as `send`, but to an explicit chat id — used for order-bot DMs. */
  async sendTo(chatId: string | number, payload: string | { text: string; photoUrl?: string; buttons?: Keyboard }): Promise<SendResult> {
    const p = typeof payload === 'string' ? { text: payload } : payload;
    const markup = p.buttons?.length ? { reply_markup: { inline_keyboard: p.buttons } } : {};

    if (p.photoUrl) {
      const sent = await this.post('sendPhoto', {
        chat_id: chatId, photo: p.photoUrl, caption: p.text, parse_mode: 'HTML', ...markup,
      });
      if (sent.ok) return { ok: true, messageId: sent.messageId, photo: true };
      // image couldn't be fetched/sent (e.g. dead gateway) — fall through to a plain text message
      log('warn', `sendPhoto failed for ${p.photoUrl} — falling back to text`);
    }

    const sent = await this.post('sendMessage', {
      chat_id: chatId, text: p.text, parse_mode: 'HTML',
      link_preview_options: { is_disabled: false }, ...markup,
    });
    return { ok: sent.ok, messageId: sent.messageId, photo: false };
  }

  /**
   * Long-poll for bot updates (DMs + button presses). 25s server-side timeout; returns `[]` on
   * any failure so the order-bot loop just polls again. `offset` must be last update_id + 1.
   */
  async getUpdates(offset: number): Promise<Array<{ update_id: number; message?: any; callback_query?: any }>> {
    const j = await this.call('getUpdates', {
      offset, timeout: 25, allowed_updates: ['message', 'callback_query'],
    }, 35_000);
    return Array.isArray(j?.result) ? j.result : [];
  }

  /** Acknowledge an inline-button press (stops the client-side spinner). Best-effort. */
  async answerCallbackQuery(id: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: id }, 10_000);
  }

  /** Pin a message in the channel (bot must be admin with pin rights). */
  async pinChatMessage(messageId: number): Promise<boolean> {
    const j = await this.call('pinChatMessage', {
      chat_id: this.chatId, message_id: messageId, disable_notification: true,
    }, 10_000);
    return j?.ok === true;
  }

  /** Delete a channel message (used to remove the previous bump before posting the next).
   * Best-effort — an already-deleted or too-old message just returns false. */
  async deleteMessage(messageId: number): Promise<boolean> {
    const j = await this.call('deleteMessage', { chat_id: this.chatId, message_id: messageId }, 10_000);
    return j?.ok === true;
  }

  /** The bot's own username (for t.me deep links), or null if unavailable. */
  async getMe(): Promise<string | null> {
    const j = await this.call('getMe', {}, 10_000);
    const username = j?.result?.username;
    return typeof username === 'string' ? username : null;
  }

  /** Single-attempt raw call returning the parsed response body, or null on any failure. */
  private async call(method: string, body: object, timeoutMs: number): Promise<any | null> {
    try {
      const res = await this.fetchFn(`https://api.telegram.org/bot${this.botToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      return await res.json().catch(() => null);
    } catch {
      return null;
    }
  }

  /**
   * Live-edit a previously sent card. `photo` selects editMessageCaption vs editMessageText.
   * MUST resend the buttons — an edit without reply_markup clears the inline keyboard.
   * Single attempt (called on a timer; the next tick is the retry). Never throws.
   */
  async editCaption(messageId: number, text: string, buttons: Keyboard, photo: boolean): Promise<boolean> {
    const markup = buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {};
    const body = photo
      ? { chat_id: this.chatId, message_id: messageId, caption: text, parse_mode: 'HTML', ...markup }
      : {
          chat_id: this.chatId, message_id: messageId, text, parse_mode: 'HTML',
          link_preview_options: { is_disabled: false }, ...markup,
        };
    const r = await this.post(photo ? 'editMessageCaption' : 'editMessageText', body, 1);
    return r.ok;
  }

  private async post(method: string, body: object, attempts = 3): Promise<{ ok: boolean; messageId?: number }> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await this.fetchFn(`https://api.telegram.org/bot${this.botToken}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const j = (await res.json().catch(() => null)) as { result?: { message_id?: number } } | null;
          return { ok: true, messageId: j?.result?.message_id };
        }
        if (res.status === 429 && attempt < attempts - 1) {
          const j = (await res.json().catch(() => null)) as { parameters?: { retry_after?: number } } | null;
          await new Promise((r) => setTimeout(r, ((j?.parameters?.retry_after ?? 3) + 1) * 1000));
        } else if (res.status === 400) {
          // "message is not modified" on an edit = the content didn't change; that's a success, not a failure
          const j = (await res.json().catch(() => null)) as { description?: string } | null;
          if (j?.description?.includes('message is not modified')) return { ok: true };
        }
      } catch {
        // retry
      }
    }
    return { ok: false };
  }
}
