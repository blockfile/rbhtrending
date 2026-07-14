import type { Db, OrderRow } from '../db/index';
import type { GmgnToken, PromoConfig, PromoTierKey } from '../types';
import type { Keyboard } from '../telegram';
import { buildButtons, GMGN_TOKEN_BASE } from '../telegram';
import { assignRank } from './slots';
import { formatLeaderboard } from './leaderboard';
import type { PaymentMatch } from './payments';
import { log } from '../logger';

/** The slice of `Telegram` PromoService needs. */
export interface PromoTelegram {
  send(payload: string | { text: string; photoUrl?: string; buttons?: Keyboard }): Promise<{ ok: boolean; messageId?: number }>;
  sendTo(chatId: string | number, payload: string | { text: string }): Promise<{ ok: boolean }>;
  editCaption(messageId: number, text: string, buttons: Keyboard, photo: boolean): Promise<boolean>;
  pinChatMessage(messageId: number): Promise<boolean>;
  getMe(): Promise<string | null>;
}

export interface PaymentWatcherLike {
  tick(): Promise<PaymentMatch[]>;
}

export interface SweeperLike {
  tick(): Promise<void>;
}

const LEADERBOARD_KEY = 'leaderboard_msg';
const TIER_LABEL: Record<string, string> = { top3: 'Top 3', top8: 'Top 8', top12: 'Top 12' };

/**
 * Runs the paid-slot lifecycle once per poll cycle: cancel unpaid quotes past their window,
 * expire lapsed slots (freeing their ranks), activate newly-paid orders (rank + buyer DM +
 * ⭐ PROMOTED channel card), and refresh the pinned ROBINHOOD TRENDING leaderboard. Every step
 * is individually best-effort — promo problems must never break the organic alert pipeline.
 */
export class PromoService {
  private botUsername: string | null = null;
  private editFailures = 0;

  constructor(
    private tg: PromoTelegram,
    private db: Db,
    private cfg: PromoConfig,
    private watcher: PaymentWatcherLike | null,
    private sweeper: SweeperLike | null = null,
  ) {}

  async tick(tokens: GmgnToken[], now: number): Promise<void> {
    await this.sweepPending(now);
    await this.sweepExpired(now);
    await this.settlePayments(now);
    await this.forwardDeposits();
    await this.updateLeaderboard(tokens, now);
  }

  /** Forward paid deposits into the treasury (best-effort; retries next tick on failure). */
  private async forwardDeposits(): Promise<void> {
    if (!this.sweeper) return;
    try {
      await this.sweeper.tick();
    } catch (err) {
      log('warn', `promo: sweep pass failed (retrying next cycle): ${(err as Error).message}`);
    }
  }

  private async sweepPending(now: number): Promise<void> {
    for (const o of this.db.cancelPendingBefore(now - this.cfg.pendingMinutes * 60_000)) {
      log('info', `promo: order #${o.id} ($${o.symbol}) quote expired unpaid`);
      await this.dm(o.chatId, `⏳ Order #${o.id} expired unpaid — send /trend to get a fresh quote.`);
    }
  }

  private async sweepExpired(now: number): Promise<void> {
    for (const o of this.db.expireActiveBefore(now)) {
      log('info', `promo: order #${o.id} ($${o.symbol}) slot ended (rank ${o.rank})`);
      await this.dm(o.chatId, `⭐ Your ${TIER_LABEL[o.tier] ?? o.tier} slot for $${o.symbol} has ended. Send /trend to renew.`);
    }
  }

  private async settlePayments(now: number): Promise<void> {
    // Complimentary admin listings activate with no payment.
    for (const o of this.db.pendingCompOrders()) {
      try {
        await this.activate({ orderId: o.id, depositAddress: 'comp' }, now);
      } catch (err) {
        log('error', `promo: activation of comp order #${o.id} failed: ${(err as Error).message}`);
      }
    }

    if (!this.watcher) return;
    let matches: PaymentMatch[];
    try {
      matches = await this.watcher.tick();
    } catch (err) {
      log('warn', `promo: payment scan failed (retrying next cycle): ${(err as Error).message}`);
      return;
    }
    for (const m of matches) {
      try {
        await this.activate(m, now);
      } catch (err) {
        log('error', `promo: activation of order #${m.orderId} failed: ${(err as Error).message}`);
      }
    }
  }

  private async activate(m: PaymentMatch, now: number): Promise<void> {
    const o = this.db.getOrder(m.orderId);
    if (!o || o.status !== 'pending') return;

    let rank = assignRank(this.cfg.tiers, o.tier as PromoTierKey, this.db.usedRanks(now));
    if (rank === null) {
      // shouldn't happen (inventory reserves pending orders) — degrade to the worst rank rather than losing a paid order
      log('error', `promo: no free rank in ${o.tier} for paid order #${o.id} — placing at ${this.cfg.leaderboardSize}`);
      rank = this.cfg.leaderboardSize;
    }
    const expiresAt = now + o.hours * 3_600_000;
    this.db.markPaid(o.id, m.depositAddress, rank, now, expiresAt);
    log('info', `promo: order #${o.id} ($${o.symbol}) ${o.comp ? 'comped (admin)' : `paid into ${m.depositAddress}`} — rank ${rank} for ${o.hours}h`);

    const lead = o.comp ? '⭐ Comped' : '✅ Payment received —';
    await this.dm(o.chatId, `${lead} your ⭐ ${TIER_LABEL[o.tier] ?? o.tier} slot for $${o.symbol} is live at #${rank} for ${o.hours}h.`);

    const card = [
      `⭐ <b>PROMOTED</b> — <b>$${escapeHtml(o.symbol)}</b>`,
      `Holding <b>#${rank}</b> on the trending board for ${o.hours}h`,
      '',
      `<a href="${GMGN_TOKEN_BASE}/${o.address}">Chart</a> · <code>${o.address}</code>`,
    ].join('\n');
    await this.tg.send({ text: card, buttons: buildButtons(o.address, { chart: true, scan: true, trade: true }) });
  }

  private async updateLeaderboard(tokens: GmgnToken[], now: number): Promise<void> {
    try {
      if (!this.botUsername) this.botUsername = (await this.tg.getMe()) ?? 'bot';
      const text = formatLeaderboard(this.db.activeOrders(now), tokens, this.cfg.leaderboardSize, this.botUsername);

      const stored = this.db.getMeta(LEADERBOARD_KEY);
      if (stored) {
        const ok = await this.tg.editCaption(Number(stored), text, [], false);
        if (ok) {
          this.editFailures = 0;
          return;
        }
        // a deleted/unpinnable message can never be edited again — re-send after repeated failures
        if (++this.editFailures < 3) return;
        log('warn', 'promo: leaderboard edit failed 3x — re-sending a fresh leaderboard message');
        this.editFailures = 0;
      }

      const r = await this.tg.send({ text });
      if (r.ok && r.messageId) {
        this.db.setMeta(LEADERBOARD_KEY, String(r.messageId));
        const pinned = await this.tg.pinChatMessage(r.messageId);
        if (!pinned) log('warn', 'promo: could not pin leaderboard (is the bot a channel admin?)');
      }
    } catch (err) {
      log('warn', `promo: leaderboard update failed: ${(err as Error).message}`);
    }
  }

  private async dm(chatId: number, text: string): Promise<void> {
    try {
      await this.tg.sendTo(chatId, { text });
    } catch (err) {
      log('warn', `promo: DM to ${chatId} failed: ${(err as Error).message}`);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
