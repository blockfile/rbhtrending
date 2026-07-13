import type { ButtonsConfig, TokenCard } from './types';
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
// GeckoTerminal network slug 'robinhood' — confirmed live (Task 2).
// Blockscout base — confirmed live at robinhoodchain.blockscout.com.
// Uniswap `chain=robinhood` slug — inferred by convention (GeckoTerminal uses the same
// slug); spot-check against a real swap link before go-live, same as Task 5's constants.
const BLOCKSCOUT_BASE = 'https://robinhoodchain.blockscout.com';

const WEB_BUTTONS: Record<'chart' | 'scan' | 'trade', { text: string; url: (address: string, poolAddress: string) => string }> = {
  chart: { text: '📊 Chart', url: (_address, pool) => `https://www.geckoterminal.com/robinhood/pools/${pool}` },
  scan: { text: '🔍 Scan', url: (address) => `${BLOCKSCOUT_BASE}/token/${address}` },
  trade: { text: '💱 Trade', url: (address) => `https://app.uniswap.org/swap?chain=robinhood&outputCurrency=${address}` },
};

/** Build the inline keyboard for a token: a single Chart / Scan / Trade row, gated by config. */
export function buildButtons(
  card: { address: string; poolAddress: string },
  cfg: ButtonsConfig,
  opts: { include?: Array<'chart' | 'scan' | 'trade'> } = {},
): Keyboard {
  const keys = opts.include ?? (['chart', 'scan', 'trade'] as const);
  const row = keys
    .filter((k) => cfg[k])
    .map((k) => ({ text: WEB_BUTTONS[k].text, url: WEB_BUTTONS[k].url(card.address, card.poolAddress) }));
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

/** Percentage without a trailing '%' (for combining two into "a/b%"); '?' when unknown/absent. */
function pctNumOrQ(v: number | 'unknown' | undefined): string {
  if (v === undefined || v === 'unknown') return '?';
  return v.toFixed(0);
}

function pctOrQ(v: number | 'unknown' | undefined): string {
  const n = pctNumOrQ(v);
  return n === '?' ? '?' : `${n}%`;
}

function numOrQ(v: number | 'unknown' | undefined): string {
  if (v === undefined || v === 'unknown') return '?';
  return String(v);
}

function boolMark(v: boolean | 'unknown' | undefined, whenTrue: string, whenFalse: string): string {
  if (v === undefined || v === 'unknown') return '?';
  return v ? whenTrue : whenFalse;
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
 * Render a TokenCard as the Telegram HTML card body. Any field that is `'unknown'` or absent
 * renders as `?` (or, for the fake-volume segment, is omitted entirely) — it never upgrades
 * the displayed security verdict toward "safe".
 */
export function formatCard(c: TokenCard): string {
  const s = c.security;
  const risk = s?.riskLevel ?? 'unknown';
  const grade = GRADE[risk];
  const securityBadge = SECURITY_EMOJI[risk];

  // v1 Option-A field set: no honeypot/tax simulation on this chain (no standard router) —
  // the badge instead reports renounce/LP/verified/transferability, and honeypot/tax are
  // always labeled "not measured" rather than rendering a stale/fake ✅.
  const renounced = boolMark(s?.ownerRenounced, '✅', '❌');
  const lp = boolMark(s?.lpBurnedOrLocked, '🔒', '❌');
  const verified = boolMark(s?.verified, '✅', '❌');
  const transfers = boolMark(s?.transferable, '✅', '❌');

  const lines = [
    `${grade} <b>$${escapeHtml(c.symbol)}</b> • ${escapeHtml(c.name)}`,
    `🛡 Security: ${securityBadge}  renounced ${renounced} · LP ${lp} · verified ${verified} · transfers ${transfers} · honeypot/tax: not measured`,
  ];
  if (c.live) lines.push(`📈 Now: ${usdOrQ(c.live.nowUsd)} • ${c.live.multiple.toFixed(1)}X`);

  const fake = c.fakeVolumePct;
  const volLine = fake !== undefined && fake !== 'unknown'
    ? `📊 Vol 1h: ${usdOrQ(c.volume1hUsd)} • 🪙 fake ~${fake.toFixed(0)}%`
    : `📊 Vol 1h: ${usdOrQ(c.volume1hUsd)}`;

  lines.push(
    `💰 MC: ${usdOrQ(c.fdvUsd)} • ⇡ ATH ${usdOrQ(c.athUsd)}`,
    `💧 Liq: ${usdOrQ(c.liquidityUsd)}`,
    volLine,
    `👥 Holders: ${numOrQ(c.holders)}`,
    `🏆 Top holder: ${pctOrQ(s?.topHolderPct)}`,
    `🐦 X ${mark(c.twitter)} | TG ${mark(c.telegram)} | Web ${mark(c.website)}`,
    '',
    `<code>${c.address}</code>`, // tap to copy — links are the buttons below
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
