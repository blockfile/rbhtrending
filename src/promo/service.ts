import type { Db, OrderRow } from '../db/index';
import type { GmgnToken, PromoConfig, PromoTierKey } from '../types';
import type { Keyboard } from '../telegram';
import { formatPromoCard } from '../telegram';
import { assess } from '../checks/assess';
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
  deleteMessage(messageId: number): Promise<boolean>;
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

  /**
   * @param organic  score-ranked pool for the pinned leaderboard (already filtered/sorted in index).
   * @param allTokens raw GMGN feed — indexed by address to render promoted cards with live stats.
   */
  async tick(organic: GmgnToken[], allTokens: GmgnToken[], now: number): Promise<void> {
    const byAddr = new Map(allTokens.map((t) => [t.address.toLowerCase(), t]));
    await this.sweepPending(now);
    await this.sweepExpired(now);
    await this.settlePayments(now, byAddr);
    await this.forwardDeposits();
    await this.bumpActive(now, byAddr);
    await this.updateLeaderboard(organic, now);
  }

  /** Re-post ("bump") each active slot's promoted card once its per-tier interval has elapsed,
   * deleting the previous post so exactly one live promoted message exists per token. */
  private async bumpActive(now: number, byAddr: Map<string, GmgnToken>): Promise<void> {
    for (const o of this.db.activeOrders(now)) {
      const intervalMs = (this.cfg.tiers[o.tier as PromoTierKey]?.bumpMinutes ?? 60) * 60_000;
      const last = o.lastBumpedAt ?? o.paidAt ?? 0;
      if (now - last < intervalMs) continue;
      try {
        await this.postPromoCard(o, byAddr, now);
      } catch (err) {
        log('warn', `promo: bump of order #${o.id} failed (retries next cycle): ${(err as Error).message}`);
      }
    }
  }

  /** Post a promoted card for an active order, first deleting its previous bump message, and
   * record the new message as the current bump. Shared by activation (first post) and bumps. */
  private async postPromoCard(o: OrderRow, byAddr: Map<string, GmgnToken>, now: number): Promise<void> {
    const rank = o.rank ?? this.cfg.leaderboardSize;
    const hoursLeft = o.expiresAt ? Math.max(0, Math.ceil((o.expiresAt - now) / 3_600_000)) : o.hours;
    const token = byAddr.get(o.address.toLowerCase());
    const card = formatPromoCard({
      symbol: o.symbol, address: o.address, rank, hoursLeft,
      token, assessment: token ? assess(token) : undefined,
    });
    if (o.bumpMsgId) await this.tg.deleteMessage(o.bumpMsgId);
    const r = await this.tg.send({ text: card.text, photoUrl: card.photoUrl, buttons: card.buttons });
    if (r.ok && r.messageId) this.db.recordBump(o.id, now, r.messageId);
  }

  /**
   * Admin removal of a promoted token (e.g. it rugged), by address. Deletes its live promoted
   * card, frees its leaderboard rank (the pinned board catches up on the next tick), and DMs the
   * buyer. No refund is issued — that stays a manual decision. Returns whether a slot was found.
   */
  async delistByAddress(address: string, _now: number): Promise<{ ok: boolean; symbol?: string; reason?: string }> {
    const o = this.db.activeOrderByAddress(address);
    if (!o) return { ok: false, reason: 'no active slot for that token' };
    if (o.bumpMsgId) await this.tg.deleteMessage(o.bumpMsgId);
    this.db.delistOrder(o.id);
    log('info', `promo: order #${o.id} ($${o.symbol}) delisted by admin`);
    await this.dm(o.chatId, `⚠️ Your ⭐ ${TIER_LABEL[o.tier] ?? o.tier} slot for $${o.symbol} was removed by an admin.`);
    return { ok: true, symbol: o.symbol };
  }

  /**
   * Admin move of a promoted token to a better (or specific) leaderboard rank, by address. Only
   * ever moves into a FREE rank — it never evicts a paying customer (if the target is occupied it
   * refuses). With no `targetRank`, moves to the lowest free rank, and only if that beats where it
   * is now. The pinned board reflects the move on the next tick.
   */
  async promoteByAddress(address: string, _now: number, targetRank?: number): Promise<{ ok: boolean; symbol?: string; rank?: number; reason?: string }> {
    const o = this.db.activeOrderByAddress(address);
    if (!o) return { ok: false, reason: 'no active slot for that token' };

    const size = this.cfg.leaderboardSize;
    const usedByOthers = new Set(this.db.usedRanks(_now).filter((r) => r !== o.rank));

    let rank: number;
    if (targetRank !== undefined) {
      if (targetRank < 1 || targetRank > size) return { ok: false, reason: `rank must be 1..${size}` };
      if (usedByOthers.has(targetRank)) return { ok: false, reason: `rank ${targetRank} is taken — /delist it first` };
      rank = targetRank;
    } else {
      let best: number | null = null;
      for (let r = 1; r <= size; r++) {
        if (!usedByOthers.has(r)) { best = r; break; }
      }
      if (best === null || (o.rank !== null && best >= o.rank)) {
        return { ok: false, reason: 'already at the best available rank' };
      }
      rank = best;
    }

    this.db.setOrderRank(o.id, rank);
    log('info', `promo: order #${o.id} ($${o.symbol}) promoted to rank ${rank} by admin`);
    return { ok: true, symbol: o.symbol, rank };
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
      if (o.bumpMsgId) await this.tg.deleteMessage(o.bumpMsgId); // remove the last promoted card
      await this.dm(o.chatId, `⭐ Your ${TIER_LABEL[o.tier] ?? o.tier} slot for $${o.symbol} has ended. Send /trend to renew.`);
    }
  }

  private async settlePayments(now: number, byAddr: Map<string, GmgnToken>): Promise<void> {
    // Complimentary admin listings activate with no payment.
    for (const o of this.db.pendingCompOrders()) {
      try {
        await this.activate({ orderId: o.id, depositAddress: 'comp' }, now, byAddr);
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
        await this.activate(m, now, byAddr);
      } catch (err) {
        log('error', `promo: activation of order #${m.orderId} failed: ${(err as Error).message}`);
      }
    }
  }

  private async activate(m: PaymentMatch, now: number, byAddr: Map<string, GmgnToken>): Promise<void> {
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

    // First promoted card (the initial bump). Re-fetch so postPromoCard sees the paid rank/expiry.
    const active = this.db.getOrder(o.id);
    if (active) await this.postPromoCard(active, byAddr, now);
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
