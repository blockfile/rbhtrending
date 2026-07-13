import type { ButtonsConfig, GmgnToken } from './types';
import type { Assessment } from './checks/assess';
import { log } from './logger';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface InlineButton {
  text: string;
  url: string;
}
export type Keyboard = InlineButton[][];

export interface SendResult {
  ok: boolean;
  messageId?: number;
  photo?: boolean;
}

// --- Robinhood Chain link targets ------------------------------------------------------
// GMGN is a full trading terminal for this chain — Chart and Trade both point there.
// Blockscout base — confirmed live at robinhoodchain.blockscout.com.
const GMGN_TOKEN_BASE = 'https://gmgn.ai/robinhood/token';
const BLOCKSCOUT_BASE = 'https://robinhoodchain.blockscout.com';

// GMGN's own logo URLs (gmgn.ai/external-res/…) sit behind a Cloudflare JS challenge that 403s
// every non-browser client — including Telegram's server-side sendPhoto fetcher — so cards sent
// with them always degrade to text. DexScreener hosts the same tokens' images on a public CDN.
const DEXSCREENER_IMG_BASE = 'https://dd.dexscreener.com/ds-data/tokens/robinhood';

/** Public CDN image URL for a token's card photo. Not every token has a DexScreener image
 * (404 → Telegram.send's existing text fallback), but unlike the GMGN logo it CAN succeed. */
export function tokenImageUrl(address: string): string {
  return `${DEXSCREENER_IMG_BASE}/${address.toLowerCase()}.png`;
}

const WEB_BUTTONS: Record<'chart' | 'scan' | 'trade', { text: string; url: (address: string) => string }> = {
  chart: { text: '📊 Chart', url: (address) => `${GMGN_TOKEN_BASE}/${address}` },
  scan: { text: '🔍 Scan', url: (address) => `${BLOCKSCOUT_BASE}/token/${address}` },
  trade: { text: '💱 Trade', url: (address) => `${GMGN_TOKEN_BASE}/${address}?tab=trade` },
};

/** Build the inline keyboard for a token: a single Chart / Scan / Trade row, gated by config. */
export function buildButtons(
  address: string,
  cfg: ButtonsConfig,
  opts: { include?: Array<'chart' | 'scan' | 'trade'> } = {},
): Keyboard {
  const keys = opts.include ?? (['chart', 'scan', 'trade'] as const);
  const row = keys
    .filter((k) => cfg[k])
    .map((k) => ({ text: WEB_BUTTONS[k].text, url: WEB_BUTTONS[k].url(address) }));
  return row.length ? [row] : [];
}

// --- Card formatting ---------------------------------------------------------------------

function usdOrQ(v: number | 'unknown' | undefined): string {
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

/** ✅/❌ presence mark for optional social links (absent = ❌, not '?' — these are truly optional, not fetch failures). */
function mark(v: string | undefined): string {
  return v ? '✅' : '❌';
}

const GRADE: Record<'safe' | 'warn' | 'danger' | 'unknown', string> = {
  safe: '🔥', warn: '⚠️', danger: '🧨', unknown: '⚠️',
};
const SECURITY_EMOJI: Record<'safe' | 'warn' | 'danger' | 'unknown', string> = {
  safe: '✅', warn: '⚠️', danger: '🧨', unknown: '❓',
};

/**
 * Render a `GmgnToken` + its `assess()` verdict as the Telegram HTML card body — the rich
 * Solana-bot-style layout (Task G2). Every GMGN field is a concrete number/boolean (never
 * 'unknown'), so unlike the old GeckoTerminal-derived card there's no '?' placeholder handling
 * here. The ⚠️ flags line and the `| ⏱ age` segment are each omitted entirely when not
 * applicable (no flags; createdAt is 0/absent), per the reference layout.
 */
export function formatCard(t: GmgnToken, a: Assessment): string {
  const grade = GRADE[a.grade];
  const securityBadge = SECURITY_EMOJI[a.grade];

  const age = ageStr(t.createdAt, Date.now());
  const ageSegment = age ? ` | ⏱ ${age}` : '';

  const lines = [
    `${grade} <b>$${escapeHtml(t.symbol)}</b> • ${escapeHtml(t.name)}`,
    `⭐ Score: ${a.score}/100${ageSegment}`,
  ];

  if (a.flags.length) lines.push(`⚠️ ${a.flags.map(escapeHtml).join(' · ')}`);

  lines.push(
    '',
    `💰 MC: ${usdOrQ(t.marketCapUsd)} • ⇡ ATH ${usdOrQ(Math.max(t.marketCapUsd, t.athMarketCapUsd))}`,
    `💧 Liq: ${usdOrQ(t.liquidityUsd)}`,
    `📊 Vol 1h: ${usdOrQ(t.volumeUsd)} • ${t.swaps} swaps`,
    `👥 Holders: ${t.holderCount} | Buyers: ${t.buys}`,
    '',
    `🛡 Security: ${securityBadge}  honeypot ${t.honeypot ? '🧨' : '❌'} · tax ${t.buyTaxPct.toFixed(0)}/${t.sellTaxPct.toFixed(0)}% · LP ${t.lpLockedPct >= 50 ? '🔒' : '🔓'} ${t.lpLockedPct.toFixed(0)}% · renounced ${t.renounced ? '✅' : '❌'} · verified ${t.verified ? '✅' : '❌'}`,
    `🏆 Top 10: ${t.top10Pct.toFixed(0)}% | 🛠 Dev: ${t.devHoldPct.toFixed(0)}%`,
    `🧠 Smart money: ${t.smartMoneyCount} · 👑 KOL: ${t.kolCount} · 🔫 Snipers: ${t.sniperCount}`,
    '',
    `🐦 X ${mark(t.twitter)} | TG ${mark(t.telegram)} | Web ${mark(t.website)}`,
    '',
    `<code>${t.address}</code>`, // tap to copy — links are the buttons below
  );
  return lines.join('\n');
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
   * Send a message. A plain string sends text; a payload with `photoUrl` sends an
   * image card (caption + buttons) and, if Telegram can't fetch the image, falls
   * back to a text message so an alert is never lost to a bad image URL.
   * Returns the delivered message's id so the caller can live-edit it later.
   */
  async send(payload: string | { text: string; photoUrl?: string; buttons?: Keyboard }): Promise<SendResult> {
    const p = typeof payload === 'string' ? { text: payload } : payload;
    const markup = p.buttons?.length ? { reply_markup: { inline_keyboard: p.buttons } } : {};

    if (p.photoUrl) {
      const sent = await this.post('sendPhoto', {
        chat_id: this.chatId, photo: p.photoUrl, caption: p.text, parse_mode: 'HTML', ...markup,
      });
      if (sent.ok) return { ok: true, messageId: sent.messageId, photo: true };
      // image couldn't be fetched/sent (e.g. dead gateway) — fall through to a plain text message
      log('warn', `sendPhoto failed for ${p.photoUrl} — falling back to text`);
    }

    const sent = await this.post('sendMessage', {
      chat_id: this.chatId, text: p.text, parse_mode: 'HTML',
      link_preview_options: { is_disabled: false }, ...markup,
    });
    return { ok: sent.ok, messageId: sent.messageId, photo: false };
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
