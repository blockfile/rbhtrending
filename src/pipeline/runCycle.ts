import type { AppConfig, PoolActivity, Security, TokenCard } from '../types';
import { trends, Tracker, type FollowEvent } from './trending';
import { enrich as defaultEnrich, type EnrichDeps } from './enrich';
import { formatCard, buildButtons, formatFollowUp, type FollowUpData, type Keyboard } from '../telegram';
import type { Db } from '../db/index';
import { log } from '../logger';

/** The two GeckoTerminal poll endpoints runCycle needs — matches `GeckoTerminal`'s shape. */
export interface GeckoLike {
  trendingPools(): Promise<PoolActivity[]>;
  newPools(): Promise<PoolActivity[]>;
}

/** The one `Telegram` method runCycle needs. */
export interface TelegramLike {
  send(payload: string | { text: string; buttons?: Keyboard }): Promise<{ ok: boolean; messageId?: number }>;
}

export interface RunCycleDeps {
  gecko: GeckoLike;
  db: Db;
  tracker: Tracker;
  telegram: TelegramLike;
  /** Live on-chain + Blockscout security scan, already bound to `evm`/`cfg.security` by the caller. */
  securityScan: (tokenAddress: string, poolAddress: string) => Promise<Security | 'unknown'>;
  cfg: AppConfig;
  dry: boolean;
  /** Defaults to the real `enrich` from ./enrich; injectable so tests can bypass securityScan wiring entirely. */
  enrich?: (activity: PoolActivity, deps: EnrichDeps) => Promise<TokenCard>;
}

/**
 * One poll cycle: fetch trending + new pools, feed already-tracked tokens fresh market-cap
 * reads (posting any milestone/dump follow-ups), and post any newly-trending, not-yet-posted
 * pool. Every external call (gecko fetch, per-pool processing, sweep) is individually
 * try/caught so one bad pool or one bad cycle never kills the process or blocks its siblings.
 *
 * NOTE: v1 discovery is poll-based only (GeckoTerminal) — there is no WS pair-listener here.
 * Live-caption editing of the original card is deferred to v1.1; v1 delivers the original card
 * plus follow-up posts only (see task-10-brief.md).
 */
export async function runCycle(deps: RunCycleDeps, now: number): Promise<void> {
  const enrichImpl = deps.enrich ?? defaultEnrich;
  const pools = await fetchPools(deps.gecko);

  for (const p of pools) {
    try {
      deps.db.recordSeen(p.address, p.symbol, p.name, now);

      if (deps.tracker.has(p.address)) {
        await processTrackedPool(deps, p, now);
      } else if (
        trends(p, deps.cfg.trending) &&
        !deps.db.alreadyPosted(p.address) &&
        deps.tracker.shouldPost(p.address)
      ) {
        await postNewTrend(deps, enrichImpl, p, now);
      }
    } catch (err) {
      log('error', `runCycle: error processing ${p.address}: ${(err as Error).message}`);
    }
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

async function fetchPools(gecko: GeckoLike): Promise<PoolActivity[]> {
  const [trending, fresh] = await Promise.all([
    safeFetch(() => gecko.trendingPools(), 'trendingPools'),
    safeFetch(() => gecko.newPools(), 'newPools'),
  ]);

  // Merge + dedupe by address, first wins (trending takes precedence over new).
  const byAddress = new Map<string, PoolActivity>();
  for (const p of [...trending, ...fresh]) {
    if (!byAddress.has(p.address)) byAddress.set(p.address, p);
  }
  return [...byAddress.values()];
}

async function safeFetch(fn: () => Promise<PoolActivity[]>, label: string): Promise<PoolActivity[]> {
  try {
    return await fn();
  } catch (err) {
    log('warn', `runCycle: ${label} failed: ${(err as Error).message}`);
    return [];
  }
}

async function processTrackedPool(deps: RunCycleDeps, p: PoolActivity, now: number): Promise<void> {
  const before = deps.tracker.get(p.address);
  const baseline = before?.baselineMcUsd ?? 0;
  const events = deps.tracker.onUpdate(p.address, p.fdvUsd, now);

  for (const ev of events) {
    // A 'dump' event ends tracking inside onUpdate, so the item is already gone from the
    // Tracker by the time we get here — fall back to the pre-call peak, which onUpdate cannot
    // have changed in the same call that produced a dump (dump requires current < peak).
    const after = deps.tracker.get(p.address);
    const peak = after?.peakMcUsd ?? before?.peakMcUsd ?? baseline;
    await postFollowUp(deps, buildFollowUpData(ev, p, baseline, peak));
  }
}

function buildFollowUpData(ev: FollowEvent, p: PoolActivity, baseline: number, peak: number): FollowUpData {
  if (ev.kind === 'up') {
    return { kind: 'up', symbol: p.symbol, address: p.address, multiple: ev.multiple, fromUsd: baseline, peakUsd: peak };
  }
  const peakPct = baseline > 0 ? ((peak - baseline) / baseline) * 100 : 0;
  const nowPct = baseline > 0 ? ((p.fdvUsd - baseline) / baseline) * 100 : 0;
  return { kind: ev.kind, symbol: p.symbol, address: p.address, peakUsd: peak, nowUsd: p.fdvUsd, peakPct, nowPct };
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

async function postNewTrend(
  deps: RunCycleDeps,
  enrichImpl: (activity: PoolActivity, deps: EnrichDeps) => Promise<TokenCard>,
  p: PoolActivity,
  now: number,
): Promise<void> {
  const card = await enrichImpl(p, { securityScan: deps.securityScan });
  const body = formatCard(card);
  const buttons = buildButtons(card, deps.cfg.buttons);

  let messageId = 0;
  let ok = true;
  if (deps.dry) {
    log('info', '[DRY] would post:\n' + body);
  } else {
    const r = await deps.telegram.send({ text: body, buttons });
    if (!r.ok) {
      log('warn', `runCycle: telegram send failed for ${p.symbol} (${p.address})`);
      ok = false;
    } else {
      messageId = r.messageId ?? 0;
    }
  }

  if (!deps.dry && ok) {
    deps.db.recordPost(p.address, messageId, now);
  }
  // Marked tracked regardless of delivery outcome (dry, success, or failure) so a token is
  // never re-attempted every cycle — matches task-10-brief.md's pipeline pseudocode.
  deps.tracker.markPosted(p.address, p.fdvUsd, now);
}
