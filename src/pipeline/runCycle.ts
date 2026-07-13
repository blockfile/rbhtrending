import type { AppConfig, GmgnToken, PoolActivity, Security, TokenCard } from '../types';
import { trends, Tracker, type FollowEvent } from './trending';
import { enrich as defaultEnrich, type EnrichDeps } from './enrich';
import type { GeckoTokenInfo } from '../sources/geckoterminal';
import { formatCard, buildButtons, formatFollowUp, type FollowUpData, type Keyboard } from '../telegram';
import { assess } from '../checks/assess';
import type { Db } from '../db/index';
import { log } from '../logger';

/** The GeckoTerminal surface runCycle needs — matches `GeckoTerminal`'s shape.
 * `hasFreshTokenInfo` (Task 13) is a cache-only check (no fetch) backing both the prefetch step
 * (skip addresses that are already warm) and the post-gate (post as soon as info is cached). */
export interface GeckoLike {
  trendingPools(): Promise<PoolActivity[]>;
  newPools(): Promise<PoolActivity[]>;
  hasFreshTokenInfo(address: string): boolean;
}

/** The one `Telegram` method runCycle needs (photoUrl optional — a card without an image just
 * sends as plain text; Telegram.send already falls back to text if the image can't be fetched). */
export interface TelegramLike {
  send(payload: string | { text: string; photoUrl?: string; buttons?: Keyboard }): Promise<{ ok: boolean; messageId?: number }>;
}

export interface RunCycleDeps {
  gecko: GeckoLike;
  db: Db;
  tracker: Tracker;
  telegram: TelegramLike;
  /** Live on-chain + Blockscout security scan, already bound to `evm`/`cfg.security` by the caller. */
  securityScan: (tokenAddress: string, poolAddress: string) => Promise<Security | 'unknown'>;
  /** GeckoTerminal token-info lookup (socials, logo, trust score, top-10 concentration), already
   * bound to a `GeckoTerminal` instance by the caller. Optional — a caller without a source for
   * it simply gets a card with those fields absent (enrich degrades this the same way it does
   * securityScan failures). */
  tokenInfo?: (address: string) => Promise<GeckoTokenInfo>;
  cfg: AppConfig;
  dry: boolean;
  /** Defaults to the real `enrich` from ./enrich; injectable so tests can bypass securityScan wiring entirely. */
  enrich?: (activity: PoolActivity, deps: EnrichDeps, securityCfg: AppConfig['security']) => Promise<TokenCard>;
}

// --- Task 13 rate-resilience knobs -------------------------------------------------------------
// GeckoTerminal's Demo key allows only ~5-6 /tokens/{addr}/info calls/minute while ~20 tokens can
// trend at once, so most info calls 429 in a single cycle. Hardcoded (not config) — these are
// implementation tuning, not user-facing behavior.
/** Uncached trending tokens to warm the tokenInfo cache for per cycle — kept small and rate-safe
 * so prefetch doesn't itself burn the whole per-minute budget the post-gate is trying to protect. */
export const PREFETCH_PER_CYCLE = 5;
/** How long a trending token may be HELD waiting on cached info before posting anyway (sparse) —
 * never withhold a real alert forever just because GeckoTerminal never granted a rate-limit slot. */
export const INFO_GRACE_MS = 3 * 60_000;

/**
 * One poll cycle: fetch trending + new pools, record first-sight for all of them, prefetch a
 * bounded number of uncached trending tokens' info (Task 13), feed already-tracked tokens fresh
 * market-cap reads (posting any milestone/dump follow-ups), and post any newly-trending,
 * not-yet-posted pool that clears the post-gate. Every external call (gecko fetch, recordSeen,
 * per-pool processing, sweep) is individually try/caught so one bad pool or one bad cycle never
 * kills the process or blocks its siblings.
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
    } catch (err) {
      log('error', `runCycle: recordSeen failed for ${p.address}: ${(err as Error).message}`);
    }
  }

  await prefetchTokenInfo(deps, pools);

  for (const p of pools) {
    try {
      if (deps.tracker.has(p.address)) {
        await processTrackedPool(deps, p, now);
      } else if (isPostCandidate(deps, p)) {
        if (shouldPostNow(deps, p.address, now)) {
          await postNewTrend(deps, enrichImpl, p, now);
        } else {
          // Post-gate HOLD (Task 13): info isn't cached yet and the grace period hasn't
          // elapsed — skip posting this cycle. Prefetch will keep trying to warm it, and it'll
          // clear the gate (cached, or grace-period expired) on a later cycle.
          log('info', `runCycle: holding ${p.symbol} (${p.address}) — info not yet cached`);
        }
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

/** A pool is eligible to post this (or a later) cycle: it clears the trending gate and has never
 * been posted. Shared between the prefetch step and the post-gate so both agree on "who's a
 * candidate" — no point warming info for a pool that isn't going to post anyway. */
function isPostCandidate(deps: RunCycleDeps, p: PoolActivity): boolean {
  return trends(p, deps.cfg.trending) && !deps.db.alreadyPosted(p.address) && deps.tracker.shouldPost(p.address);
}

/** Post-gate (Task 13): a trending, not-yet-posted token posts this cycle only once its
 * GeckoTerminal info is cached, OR it's been sitting uncached longer than INFO_GRACE_MS — at
 * which point it posts anyway (sparse) rather than being held forever. */
function shouldPostNow(deps: RunCycleDeps, address: string, now: number): boolean {
  if (deps.gecko.hasFreshTokenInfo(address)) return true;
  const firstSeen = deps.db.firstSeen(address) ?? now;
  return now - firstSeen >= INFO_GRACE_MS;
}

/** Prefetch (Task 13): before the post loop, best-effort warm the tokenInfo cache for up to
 * PREFETCH_PER_CYCLE uncached post-candidate tokens, so they clear the post-gate cached (rich)
 * on this cycle or the next rather than posting sparse after the grace period. A no-op when the
 * caller didn't wire a tokenInfo source. Failures are swallowed — same best-effort contract
 * `enrich`'s own tokenInfo call already has; a cold cache just means the gate falls back to the
 * grace period instead. */
async function prefetchTokenInfo(deps: RunCycleDeps, pools: PoolActivity[]): Promise<void> {
  if (!deps.tokenInfo) return;
  let budget = PREFETCH_PER_CYCLE;
  for (const p of pools) {
    if (budget <= 0) break;
    if (!isPostCandidate(deps, p)) continue;
    if (deps.gecko.hasFreshTokenInfo(p.address)) continue;
    budget--;
    try {
      await deps.tokenInfo(p.address);
    } catch {
      // best-effort — a failed prefetch just leaves the cache cold; the gate's grace period covers it
    }
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

/**
 * TEMPORARY (Task G2): `formatCard`/`buildButtons` were repointed to the GMGN-sourced
 * `GmgnToken`/`Assessment` shape, but this pipeline still runs on the GeckoTerminal-era
 * PoolActivity/TokenCard/enrich stack — Task G3 rewires `postNewTrend` to fetch GmgnToken rows
 * directly and deletes this adapter. Until then, this maps a TokenCard's overlapping fields
 * onto a GmgnToken (defaulting fields TokenCard has no source for — swaps, sells, top10Pct/dev
 * concentration beyond topHolderPct, depth counts — to 0/false) purely so the card keeps
 * compiling and posting with reasonable values from what data is actually available.
 */
function tokenCardToGmgnToken(card: TokenCard): GmgnToken {
  const s = card.security;
  const num = (v: number | 'unknown' | undefined): number => (typeof v === 'number' ? v : 0);
  return {
    address: card.address,
    name: card.name,
    symbol: card.symbol,
    priceUsd: num(card.priceUsd),
    priceChange1hPct: 0,
    volumeUsd: num(card.volume1hUsd),
    liquidityUsd: num(card.liquidityUsd),
    marketCapUsd: num(card.fdvUsd),
    athMarketCapUsd: num(card.athUsd),
    swaps: 0,
    buys: num(card.buyers1h),
    sells: 0,
    holderCount: num(card.holders),
    top10Pct: num(s?.topHolderPct),
    createdAt: card.createdAt,
    twitter: card.twitter,
    telegram: card.telegram,
    website: card.website,
    honeypot: s?.honeypot === true,
    buyTaxPct: num(s?.buyTaxPct),
    sellTaxPct: num(s?.sellTaxPct),
    renounced: s?.ownerRenounced === true,
    verified: s?.verified === true,
    lpLockedPct: s?.lpBurnedOrLocked === true ? 100 : 0,
    devHoldPct: 0,
    rugRatioPct: 0,
    burnPct: 0,
    smartMoneyCount: 0,
    kolCount: 0,
    sniperCount: 0,
    bundlerRatePct: 0,
    washTrading: false,
    hotLevel: 0,
  };
}

async function postNewTrend(
  deps: RunCycleDeps,
  enrichImpl: (activity: PoolActivity, deps: EnrichDeps, securityCfg: AppConfig['security']) => Promise<TokenCard>,
  p: PoolActivity,
  now: number,
): Promise<void> {
  const card = await enrichImpl(p, { securityScan: deps.securityScan, tokenInfo: deps.tokenInfo }, deps.cfg.security);
  const gmgnLike = tokenCardToGmgnToken(card);
  const body = formatCard(gmgnLike, assess(gmgnLike));
  const buttons = buildButtons(card.address, deps.cfg.buttons);

  let messageId = 0;
  let ok = true;
  if (deps.dry) {
    log('info', '[DRY] would post:\n' + body);
    if (card.imageUrl) log('info', `[DRY] image: ${card.imageUrl}`);
  } else {
    const r = await deps.telegram.send({ text: body, photoUrl: card.imageUrl, buttons });
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
