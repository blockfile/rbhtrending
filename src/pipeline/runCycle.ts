import type { AppConfig, GmgnToken } from '../types';
import { passesGate, Tracker, type FollowEvent } from './trending';
import { formatCard, buildButtons, formatFollowUp, type FollowUpData, type Keyboard } from '../telegram';
import { assess } from '../checks/assess';
import type { Db } from '../db/index';
import { log } from '../logger';

/** The one `GmgnClient` method runCycle needs — `.trending()` is already best-effort (returns
 * `[]` on any failure) so runCycle doesn't need to know about GMGN's HTTP/envelope details. */
export interface GmgnLike {
  trending(interval?: string, limit?: number): Promise<GmgnToken[]>;
}

/** The one `Telegram` method runCycle needs (photoUrl optional — a card without an image just
 * sends as plain text; Telegram.send already falls back to text if the image can't be fetched). */
export interface TelegramLike {
  send(payload: string | { text: string; photoUrl?: string; buttons?: Keyboard }): Promise<{ ok: boolean; messageId?: number }>;
}

export interface RunCycleDeps {
  gmgn: GmgnLike;
  db: Db;
  tracker: Tracker;
  telegram: TelegramLike;
  cfg: AppConfig;
  dry: boolean;
}

/**
 * One poll cycle (Task G3): a single `gmgn.trending('1h', 100)` call returns every trending
 * token with ALL the data a card needs (price/mc/liq/vol, holders, security flags, socials,
 * logo) — no per-token enrichment, no rate-limit prefetch/cache/grace machinery. For each
 * returned token: record first-sight, feed already-tracked tokens a fresh market-cap read
 * (posting any milestone/dump follow-ups), and post any newly-trending, not-yet-posted token
 * that clears the trending gate. Every external call (the gmgn fetch, and each token's
 * processing) is individually try/caught so one bad token or one bad cycle never kills the
 * process or blocks its siblings.
 *
 * Task G4 — cold-start silent seed + per-cycle post cap: a live trending channel should alert
 * tokens as they NEWLY start trending, not dump the ~80 already trending at boot. On the very
 * first-ever run (`db.postCount() === 0`), a gate-passing token is silently marked as already
 * posted instead of alerted — this seeds the DB so only tokens that start trending *after* boot
 * ever alert. On every later cycle, brand-new posts are capped at `maxPostsPerCycle` per cycle
 * to throttle bursts; anything over the cap is simply picked up again on a later cycle since it
 * remains gate-passing and unposted. Neither applies to the tracked-token follow-up branch
 * above, which always runs first and is unaffected.
 */
export async function runCycle(deps: RunCycleDeps, now: number): Promise<void> {
  const tokens = await fetchTrending(deps.gmgn);
  const coldStart = deps.db.postCount() === 0;
  let postedThisCycle = 0;
  let seeded = 0;

  for (const t of tokens) {
    try {
      deps.db.recordSeen(t.address, t.symbol, t.name, now);

      if (deps.tracker.has(t.address)) {
        await processTrackedToken(deps, t, now);
        continue;
      }

      if (passesGate(t, deps.cfg.trending) && !deps.db.alreadyPosted(t.address) && deps.tracker.shouldPost(t.address)) {
        if (coldStart) {
          // Silent seed: mark as posted (so it never back-alerts) without sending, tracking, or
          // even assessing/formatting it — this token was already trending before boot.
          if (!deps.dry) deps.db.recordPost(t.address, 0, now);
          seeded++;
          continue;
        }
        if (postedThisCycle >= deps.cfg.trending.maxPostsPerCycle) {
          continue; // cap reached — deferred to a later cycle, still gate-passing & unposted
        }
        await postNewTrend(deps, t, now);
        postedThisCycle++;
      }
    } catch (err) {
      log('error', `runCycle: error processing ${t.address}: ${(err as Error).message}`);
    }
  }

  if (coldStart) {
    const verb = deps.dry ? 'would seed' : 'seeded';
    log('info', `cold start: ${verb} ${seeded} trending tokens (no alerts sent) — will alert new entrants from now`);
  }

  try {
    for (const { address, event } of deps.tracker.sweep(now)) {
      // v1: a window-expiry recap post is optional (deferred detail work); logging is dry-safe
      // by construction since it never touches Telegram.
      log('info', `[window] ${address} tracking window closed (${event.kind})`);
    }
  } catch (err) {
    log('warn', `runCycle: sweep failed: ${(err as Error).message}`);
  }
}

async function fetchTrending(gmgn: GmgnLike): Promise<GmgnToken[]> {
  try {
    return await gmgn.trending('1h', 100);
  } catch (err) {
    log('warn', `runCycle: gmgn.trending failed: ${(err as Error).message}`);
    return [];
  }
}

async function processTrackedToken(deps: RunCycleDeps, t: GmgnToken, now: number): Promise<void> {
  const before = deps.tracker.get(t.address);
  const baseline = before?.baselineMcUsd ?? 0;
  const events = deps.tracker.onUpdate(t.address, t.marketCapUsd, now);

  for (const ev of events) {
    // A 'dump' event ends tracking inside onUpdate, so the item is already gone from the
    // Tracker by the time we get here — fall back to the pre-call peak, which onUpdate cannot
    // have changed in the same call that produced a dump (dump requires current < peak).
    const after = deps.tracker.get(t.address);
    const peak = after?.peakMcUsd ?? before?.peakMcUsd ?? baseline;
    await postFollowUp(deps, buildFollowUpData(ev, t, baseline, peak));
  }
}

function buildFollowUpData(ev: FollowEvent, t: GmgnToken, baseline: number, peak: number): FollowUpData {
  if (ev.kind === 'up') {
    return { kind: 'up', symbol: t.symbol, address: t.address, multiple: ev.multiple, fromUsd: baseline, peakUsd: peak };
  }
  const peakPct = baseline > 0 ? ((peak - baseline) / baseline) * 100 : 0;
  const nowPct = baseline > 0 ? ((t.marketCapUsd - baseline) / baseline) * 100 : 0;
  return { kind: ev.kind, symbol: t.symbol, address: t.address, peakUsd: peak, nowUsd: t.marketCapUsd, peakPct, nowPct };
}

async function postFollowUp(deps: RunCycleDeps, data: FollowUpData): Promise<void> {
  try {
    const text = formatFollowUp(data);
    if (deps.dry) {
      log('info', '[DRY] follow-up:\n' + text);
      return;
    }
    const r = await deps.telegram.send({ text });
    if (!r.ok) log('warn', `runCycle: follow-up send failed for ${data.address}`);
  } catch (err) {
    log('warn', `runCycle: follow-up send threw for ${data.address}: ${(err as Error).message}`);
  }
}

async function postNewTrend(deps: RunCycleDeps, t: GmgnToken, now: number): Promise<void> {
  const a = assess(t);
  const body = formatCard(t, a);
  const buttons = buildButtons(t.address, deps.cfg.buttons);

  if (deps.dry) {
    log('info', '[DRY] would post:\n' + body);
    if (t.logo) log('info', `[DRY] image: ${t.logo}`);
  } else {
    const r = await deps.telegram.send({ text: body, photoUrl: t.logo, buttons });
    if (!r.ok) {
      log('warn', `runCycle: telegram send failed for ${t.symbol} (${t.address})`);
      return; // not marked tracked — a failed send is retried next cycle since it was never posted
    }
    deps.db.recordPost(t.address, r.messageId ?? 0, now);
  }
  // Marked tracked once posting has been attempted successfully (dry or a real, delivered send)
  // so a token is never re-attempted every cycle — matches task-10-brief.md's pipeline pseudocode.
  deps.tracker.markPosted(t.address, t.marketCapUsd, now);
}
