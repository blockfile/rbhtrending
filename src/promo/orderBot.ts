import type { Db } from '../db/index';
import type { PromoConfig, PromoTierKey } from '../types';
import type { Keyboard } from '../telegram';
import type { WalletStore } from './walletStore';
import { priceToWei, formatEth, slotsLeft, TIER_ORDER } from './slots';
import { log } from '../logger';

/** The slice of `Telegram` the order bot needs. `getUpdates` is only required for `run()`. */
export interface OrderBotTelegram {
  sendTo(chatId: string | number, payload: string | { text: string; buttons?: Keyboard }): Promise<{ ok: boolean }>;
  answerCallbackQuery(id: string): Promise<void>;
  getUpdates?(offset: number): Promise<Array<{ update_id: number; message?: any; callback_query?: any }>>;
}

const CA_RE = /^0x[0-9a-fA-F]{40}$/;
const BUY_RE = /^buy:(top3|top8|top12):(3|6|24)$/;

const TIER_LABEL: Record<PromoTierKey, string> = { top3: 'Top 3', top8: 'Top 8', top12: 'Top 12' };

interface Draft {
  address: string;
  symbol: string;
}

/**
 * Self-serve DM flow for buying a ⭐ trending slot, mirroring the Solana slot-menu pattern:
 * `/trend` → send the token CA → 3×3 tier/duration inline menu → exact-amount ETH quote to the
 * shared payment wallet. Payment detection + activation live in PromoService, not here.
 * Conversation state is in-memory (a restart just means the buyer re-runs /trend); pending
 * orders themselves are durable in SQLite.
 */
export class OrderBot {
  private drafts = new Map<number, Draft | 'awaiting_ca'>();
  private offset = 0;
  private stopped = false;

  constructor(
    private tg: OrderBotTelegram,
    private db: Db,
    private cfg: PromoConfig,
    private wallets: WalletStore,
    /** Resolves an ERC-20 address to its symbol (null → fall back to a shortened address). */
    private symbolFn: (address: string) => Promise<string | null>,
    /** Admin `/delist` handler (removes a promoted token). Injected by index (→ PromoService). */
    private delistFn?: (address: string) => Promise<{ ok: boolean; symbol?: string; reason?: string }>,
    /** Admin `/promote` handler (moves a token to a free rank). Injected by index (→ PromoService). */
    private promoteFn?: (address: string, rank?: number) => Promise<{ ok: boolean; symbol?: string; rank?: number; reason?: string }>,
  ) {}

  /** Long-poll loop for DMs/button presses. Never throws; `stop()` ends it. */
  async run(): Promise<void> {
    if (!this.tg.getUpdates) throw new Error('OrderBot.run needs a Telegram with getUpdates');
    log('info', 'order bot: DM loop started');
    while (!this.stopped) {
      try {
        const updates = await this.tg.getUpdates(this.offset);
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          await this.handleUpdate(u, Date.now());
        }
      } catch (err) {
        log('warn', `order bot: update loop error: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private isAdmin(chatId: number): boolean {
    return this.cfg.adminChatIds.includes(chatId);
  }

  async handleUpdate(u: { message?: any; callback_query?: any }, now: number): Promise<void> {
    try {
      if (u.callback_query) return await this.handlePress(u.callback_query, now);
      const msg = u.message;
      if (!msg || msg.chat?.type !== 'private' || typeof msg.text !== 'string') return;
      await this.handleMessage(msg.chat.id as number, msg.text.trim(), now);
    } catch (err) {
      log('warn', `order bot: update failed: ${(err as Error).message}`);
    }
  }

  private async handleMessage(chatId: number, text: string, _now: number): Promise<void> {
    // Admin-only: remove a promoted token (e.g. it rugged). Non-admins fall through to /trend.
    if (this.isAdmin(chatId) && text.startsWith('/delist')) {
      const arg = text.slice('/delist'.length).trim();
      if (!CA_RE.test(arg)) {
        await this.tg.sendTo(chatId, { text: 'Usage: <code>/delist 0x…</code> — the token address to remove from trending.' });
        return;
      }
      const r = this.delistFn ? await this.delistFn(arg.toLowerCase()) : { ok: false, reason: 'delisting unavailable' };
      await this.tg.sendTo(chatId, {
        text: r.ok
          ? `🗑 Removed <b>$${escape(r.symbol ?? '')}</b> from the trending board.`
          : `Couldn't delist — ${escape(r.reason ?? 'not found')}.`,
      });
      return;
    }

    // Admin-only: move a token up into a free slot. `/promote <CA> [rank]`.
    if (this.isAdmin(chatId) && text.startsWith('/promote')) {
      const [addr, rankStr] = text.slice('/promote'.length).trim().split(/\s+/);
      const rank = rankStr ? Number(rankStr) : undefined;
      if (!addr || !CA_RE.test(addr) || (rankStr !== undefined && !Number.isInteger(rank))) {
        await this.tg.sendTo(chatId, { text: 'Usage: <code>/promote 0x… [rank]</code> — move a token to a free slot (default: best free rank).' });
        return;
      }
      const r = this.promoteFn ? await this.promoteFn(addr.toLowerCase(), rank) : { ok: false, reason: 'promoting unavailable' };
      await this.tg.sendTo(chatId, {
        text: r.ok
          ? `⬆️ Moved <b>$${escape(r.symbol ?? '')}</b> to #${r.rank}.`
          : `Couldn't promote — ${escape(r.reason ?? 'not found')}.`,
      });
      return;
    }

    if (text === '/trend' || text.startsWith('/start')) {
      this.drafts.set(chatId, 'awaiting_ca');
      await this.tg.sendTo(chatId, {
        text: '⭐ <b>Buy a trending slot</b>\n\nSend the <b>contract address</b> (0x…) of the token you want on the ROBINHOOD TRENDING leaderboard.',
      });
      return;
    }

    const state = this.drafts.get(chatId);
    if (CA_RE.test(text)) {
      const address = text.toLowerCase();
      const symbol = (await this.symbolFn(address)) ?? `${address.slice(0, 6)}…${address.slice(-4)}`;
      this.drafts.set(chatId, { address, symbol });
      const hint = this.isAdmin(chatId)
        ? '\n\n👑 <i>Admin: tapping a slot lists this token free.</i>'
        : '';
      await this.tg.sendTo(chatId, {
        text: `Token: <b>$${escape(symbol)}</b>\n<code>${address}</code>\n\nPick a slot — position tier × duration:${hint}`,
        buttons: this.menu(),
      });
      return;
    }

    if (state === 'awaiting_ca') {
      await this.tg.sendTo(chatId, { text: "That doesn't look like a valid contract address — send the 0x… address of your token." });
      return;
    }

    await this.tg.sendTo(chatId, { text: 'Send /trend to buy a ⭐ trending slot.' });
  }

  private menu(): Keyboard {
    return TIER_ORDER.map((tier) => {
      const left = slotsLeft(this.cfg, tier, this.db.openOrderCountByTier(tier));
      return Object.entries(this.cfg.tiers[tier].prices).map(([hours, price]) => ({
        text: `${TIER_LABEL[tier]} · ${hours}h · ${price} ETH${left === 0 ? ' ❌' : ''}`,
        callback_data: `buy:${tier}:${hours}`,
      })) as unknown as Keyboard[number];
    });
  }

  private async handlePress(cb: { id: string; data?: string; message?: any }, now: number): Promise<void> {
    await this.tg.answerCallbackQuery(cb.id);
    const chatId = cb.message?.chat?.id as number | undefined;
    const m = typeof cb.data === 'string' ? BUY_RE.exec(cb.data) : null;
    if (!chatId || !m) return;
    const tier = m[1] as PromoTierKey;
    const hours = Number(m[2]);

    const draft = this.drafts.get(chatId);
    if (!draft || draft === 'awaiting_ca') {
      await this.tg.sendTo(chatId, { text: 'Session expired — send /trend to start again.' });
      return;
    }

    // Admins comp a free listing: no payment, no deposit wallet, bypasses sold-out. It activates
    // on the next promo tick like any paid slot.
    if (this.isAdmin(chatId)) {
      const id = this.db.createOrder({
        chatId, address: draft.address, symbol: draft.symbol, tier, hours,
        amountWei: '0', depositAddress: '', derivIndex: 0, now, comp: true,
      });
      this.drafts.delete(chatId);
      await this.tg.sendTo(chatId, {
        text: `⭐ Listed <b>$${escape(draft.symbol)}</b> free — ${TIER_LABEL[tier]} · ${hours}h. It goes live on the next update.`,
      });
      return;
    }

    if (slotsLeft(this.cfg, tier, this.db.openOrderCountByTier(tier)) <= 0) {
      await this.tg.sendTo(chatId, { text: `${TIER_LABEL[tier]} is sold out right now — try another tier, or again once a slot expires.` });
      return;
    }

    const amountWei = priceToWei(this.cfg.tiers[tier].prices[String(hours)]);
    // Reserve the order id first, then derive its dedicated deposit wallet from that id.
    const id = this.db.createOrder({ chatId, address: draft.address, symbol: draft.symbol, tier, hours, amountWei, depositAddress: '', derivIndex: 0, now });
    const dep = this.wallets.allocate(id);
    this.db.setOrderDeposit(id, dep.address, dep.index);
    this.drafts.delete(chatId);

    await this.tg.sendTo(chatId, {
      text: [
        `🧾 <b>Order #${id}</b> — ⭐ ${TIER_LABEL[tier]} slot · ${hours}h for $${escape(draft.symbol)}`,
        '',
        `Send <b>${formatEth(amountWei)} ETH</b> on <b>Robinhood Chain</b> to your dedicated deposit address:`,
        `<code>${dep.address}</code>`,
        '',
        `⏳ Quote expires in ${this.cfg.pendingMinutes} min. This address is unique to your order — your slot activates automatically after ${this.cfg.confirmations} confirmations.`,
      ].join('\n'),
    });
  }
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
