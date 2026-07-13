# Task 13 Report: rate-resilient enrichment (free logos, warm cache, prefetch + post-when-enriched)

## Status
DONE — all requirements met, whole suite green, typecheck clean, commit created.

## Commit
`<filled in after commit>` — `feat: rate-resilient enrichment (free logos, warm cache, prefetch + post-when-enriched)`

## Test Summary
Full repo suite (`npx vitest run`) → **214/214 passed** across 13 files (up from 193). New
coverage: `tests/geckoterminal.test.ts` +10 (include=base_token URL x2, include-image mapping x3,
`hasFreshTokenInfo` x2, 429-retry/Retry-After/attempt-bump x3), `tests/db.test.ts` +3 (`firstSeen`),
`tests/enrich.test.ts` +3 (image fallback/precedence/both-absent), `tests/runCycle.test.ts` +5
(post-gate HOLD/POST-once-fresh/grace-period/prefetch-cap/no-tokenInfo-dep). Ran twice full-suite
green plus two extra isolated stress runs of the two timing-sensitive files
(`geckoterminal.test.ts` + `runCycle.test.ts`, 49/49 both times) to rule out flakiness in the new
fake-timer-based 429/TTL tests. `npm run typecheck` → clean, no errors.

TDD followed: wrote all new/changed tests first (types.ts's trivial `imageUrl` field addition was
the one exception — needed before the enrich fallback tests could even compile), ran the full
suite and confirmed RED (16 failures, all for the expected reasons — missing `hasFreshTokenInfo`,
missing `?include=base_token`, missing `db.firstSeen`, missing post-gate/prefetch, missing image
fallback), then implemented until green. Iterated twice after the first GREEN attempt: (1) an
inline `GeckoLike` fake in a pre-existing runCycle test needed `hasFreshTokenInfo` added since the
interface grew a required method; (2) two pre-existing `tokenInfo` tests (500/throw) now retry 3x
with real 2s rate-limit gaps between attempts and exceeded vitest's default 5s test timeout — gave
them an explicit 10s timeout; (3) the new fake-timer tests initially fought the module-scoped
`lastCallTime` rate-limiter clock (real-`Date.now()`-based) leaking drift across sequential fake
vs. real timer tests within the same file — fixed with a small test-only
`__resetRateLimiterForTests()` export plus reordering the fake-timer TTL test to the very end of
the file (see "What was built" below for the full explanation).

## What was built

### `src/types.ts`
Added `imageUrl?: string` to `PoolActivity` — the free per-token logo carried alongside a trending/
new pool from Part A's `?include=base_token` sideload.

### `src/sources/geckoterminal.ts` — Part A (free logos) + Part B (warm cache/429 handling)
- **Part A**: `trendingPools`/`newPools` now share a private `fetchPoolList(path)` helper that
  appends `?include=base_token` to the URL, parses `data.included` into an id→imageUrl `Map` via
  `buildImageMap` (skips empty/`'missing.png'` placeholder images), and attaches the matching
  image onto each parsed `PoolActivity` via `withImage` (looked up by the raw pool's
  `relationships.base_token.data.id`, which is exactly the included token object's own `id`).
  Best-effort: no match leaves `imageUrl` undefined; `parsePool`'s own signature/behavior is
  untouched.
- **Part B — cache TTL**: raised `TOKEN_INFO_TTL_MS` from 15 minutes to 6 hours.
- **Part B — `hasFreshTokenInfo(address)`**: new public method, cache-only (no fetch) — true iff a
  non-expired entry exists for the lowercased address.
- **Part B — 429 handling**: `fetchWithRetry` gained a `maxAttempts = 2` parameter (default
  preserves the existing trending/new-pools behavior). On a 429 that isn't the final attempt, it
  now waits before retrying — honors a numeric `Retry-After` header (seconds) if present, else
  3000ms — via `Number(response.headers?.get?.('retry-after'))`. `tokenInfo` now calls
  `fetchWithRetry(url, 3)` (bumped from the shared default of 2) since it's the endpoint that
  actually gets rate-limited under the Demo key.
- **Test-only export**: `__resetRateLimiterForTests()` resets the module-scoped `lastCallTime` to
  0. Needed because `lastCallTime` is real-`Date.now()`-based and shared across every
  `GeckoTerminal` instance in the process; a fake-timer test exercising the 429-wait path needs a
  clean slate rather than inheriting a timestamp (in real or fake time) left by whatever ran
  before it — see "Self-review notes" for the full failure mode this fixes. Not called by
  production code.

### `src/db/index.ts`
Added `firstSeen(address): number | null` — reads `first_seen` from the `tokens` table (null if
unseen). Trivial read-through; `recordSeen` already stored the value.

### `src/pipeline/enrich.ts`
One-line change: `imageUrl: info.imageUrl ?? activity.imageUrl` — prefers the richer `/info` image,
falls back to the free include-image so every posted card gets a logo even when `/info` was
rate-limited or never cached this cycle.

### `src/pipeline/runCycle.ts` — the post-gate + prefetch
- `GeckoLike` gained `hasFreshTokenInfo(address): boolean`.
- Two exported, hardcoded knobs: `PREFETCH_PER_CYCLE = 5`, `INFO_GRACE_MS = 3 * 60_000` (exported
  so tests reference the same source of truth rather than duplicating magic numbers).
- `runCycle` restructured into three passes instead of one combined loop: (1) `recordSeen` for
  every merged pool (still individually try/caught, same failure-isolation as before); (2)
  `prefetchTokenInfo(deps, pools)` — best-effort, runs BEFORE the post loop; (3) the per-pool
  tracked/post loop (unchanged shape, still individually try/caught), now gated by the post-gate.
- `isPostCandidate(deps, p)` — extracted helper (`trends(p, cfg) && !alreadyPosted && shouldPost`),
  shared between the prefetch step and the post-gate so both agree on "who's a candidate" (no
  point warming info for a pool that isn't a posting candidate anyway). This is the interpretation
  used for the brief's "trending pools" in the prefetch spec — a trending-gate-passing,
  never-posted pool, not literally "came from the `trendingPools()` endpoint specifically" (the
  merged trending+new pool list is what's available at that point in the cycle, and only
  candidates matter for prefetch/post purposes either way).
- `shouldPostNow(deps, address, now)` — the post-gate: `hasFreshTokenInfo(address) ||
  now - (db.firstSeen(address) ?? now) >= INFO_GRACE_MS`. A candidate that fails the gate is
  HELD (logged, not posted) this cycle rather than posted sparse.
- `prefetchTokenInfo(deps, pools)` — no-op if `deps.tokenInfo` wasn't wired; otherwise walks
  `pools` in order, skipping non-candidates and already-fresh addresses, calling
  `deps.tokenInfo(addr)` (best-effort, swallows failures) for up to `PREFETCH_PER_CYCLE` of them.
- `postNewTrend`/`processTrackedPool`/sweep logic themselves are unchanged — dedupe, follow-ups,
  `--dry`, and the re-entrancy guard (in `src/index.ts`, untouched) all still work exactly as
  before.

### `src/index.ts`
No changes — per the brief. `RunCycleDeps.gecko` is the real `GeckoTerminal` instance, which now
structurally satisfies the extended `GeckoLike` (it already has `hasFreshTokenInfo`); the
`tokenInfo: (a) => gecko.tokenInfo(a)` wiring from Task 12 is reused as-is for prefetch.

## Tests
- `tests/geckoterminal.test.ts` — `trendingPools`/`newPools` request `?include=base_token`; a
  fixture with an `included` token array maps its image onto the matching `PoolActivity` by
  `relationships.base_token.data.id`; a `missing.png` included image and an absent `included`
  array both leave `imageUrl` undefined; `hasFreshTokenInfo` is false for a never-fetched address
  and (in a fake-timer test placed last in the file) true right after a `tokenInfo` fetch, false
  again once the 6h TTL elapses; three 429-path tests on `tokenInfo` — honors a numeric
  `Retry-After` header (5s) over the 3s default, falls back to the 3s default when no header is
  present, and confirms two consecutive 429s still succeed on the 3rd attempt (locking in the
  attempts-bump to 3). Two pre-existing 500/throw `tokenInfo` tests got an explicit 10s timeout
  since they now retry 3x with real inter-attempt rate-limit gaps.
- `tests/db.test.ts` — `firstSeen` returns null for an unseen address, returns the stored
  timestamp after `recordSeen`, and stays at the original timestamp when `recordSeen` is called
  again later for the same address (idempotent `INSERT OR IGNORE` already guaranteed this; the
  test locks it in).
- `tests/enrich.test.ts` — falls back to `activity.imageUrl` when `tokenInfo` has none; prefers
  `tokenInfo`'s image when both are present; leaves `imageUrl` undefined when neither is present.
- `tests/runCycle.test.ts` — the shared `gecko()` fake factory gained a settable
  `hasFreshTokenInfo` option (defaulting to always-true so every pre-existing test, which expects
  a trending token to post in the very same cycle it first appears, needed zero changes). New
  `describe('post-gate + prefetch ...')` block: (a) a trending token with uncached info, first-seen
  this same cycle, is HELD (no send, not tracked, but still recorded seen); (b) the same setup
  posts once `hasFreshTokenInfo` flips true on a later cycle well inside the grace period; (c) a
  token held with permanently-uncached info still posts once `now - firstSeen >= INFO_GRACE_MS`;
  (d) prefetch calls `tokenInfo` for uncached candidates capped at `PREFETCH_PER_CYCLE` (7 pools
  offered, exactly 5 calls made); (e) no prefetch call happens (and posting still works normally)
  when no `tokenInfo` dep is wired. An inline `GeckoLike` fake in a pre-existing test
  (`'a bad gecko fetch ... degrades to empty'`) needed `hasFreshTokenInfo: () => true` added since
  the interface grew a required method.

## Self-review notes
- `git status --short` after staging showed exactly the 9 intended files (`src/db/index.ts`,
  `src/pipeline/enrich.ts`, `src/pipeline/runCycle.ts`, `src/sources/geckoterminal.ts`,
  `src/types.ts`, `tests/db.test.ts`, `tests/enrich.test.ts`, `tests/geckoterminal.test.ts`,
  `tests/runCycle.test.ts`) — no `.env`, nothing under `data/`/`logs/`, nothing stray.
  `src/index.ts` correctly untouched.
- Did not read, print, or commit any `.env` file; never ran the bot (`npm start`/`npm run dry`).
- Confirmed RED before GREEN: ran the full suite after writing all new tests first and saw 16
  failures, all for the expected reasons, before writing any implementation code.
- Real bug hunted down and fixed during RED→GREEN: the fake-timer 429/TTL tests initially failed
  unpredictably (`expected 0/2 to be 1`) even after the implementation was otherwise correct. Root
  cause: `lastCallTime` (the inter-call rate limiter's clock in `geckoterminal.ts`) is
  module-scoped and shared across every test in the file, and is set via `Date.now()` — which
  returns *fake* time while `vi.useFakeTimers()` is active and *real* time otherwise. A fake-timer
  test that advances its clock by, say, 7 seconds to exercise a `Retry-After` wait leaves
  `lastCallTime` sitting ~7 (fake) seconds ahead of wherever the *next* test's clock starts
  (real or freshly-faked, both anchored near actual wall-clock "now"), making that next test's
  first rate-limit check compute a large negative `elapsed` and wait far longer than any
  reasonable `advanceTimersByTimeAsync` budget would clear — or, worse, when the drift-causing
  test is the 6-hour TTL-expiry test, a *real*-timer test running immediately after it would
  compute `elapsed` skewed by a real 6 hours and hang effectively forever on `rateLimit()`'s
  `setTimeout`. Fixed two ways: (1) added a small test-only `__resetRateLimiterForTests()` export
  and call it at the start — and, defensively, also at the end — of every fake-timer test; (2)
  moved the TTL-expiry test (the one with the multi-hour advance) to the very end of the file so
  no real-timer test ever runs after it regardless of future edits. This is a pre-existing
  test-infrastructure hazard (the module state existed before Task 13; Task 13 just added the
  first tests that both use fake timers AND exercise `fetchWithRetry`), not a production bug —
  `__resetRateLimiterForTests()` is never called by application code.
- Deliberately reused the trending-gate check (`isPostCandidate`) between the prefetch step and
  the post-gate rather than prefetching a different/broader set — see "What was built" above for
  why "trending pools" in the brief's prefetch spec was read as "post-candidate pools" rather than
  literally the `trendingPools()`-endpoint-only subset.

## Concerns
- The "trending pools" wording in the brief's prefetch spec is slightly ambiguous between "pools
  from the `trendingPools()` endpoint specifically" and "pools that pass the trending gate"
  (the merged trending+new list, filtered by `trends()`). I implemented the latter (via the shared
  `isPostCandidate` helper) since it's the set that actually matters for the post-gate this
  prefetch exists to serve, and a `new_pools`-sourced token that also clears the trending
  threshold is exactly as much a "trending token" in the product sense. Worth a second look if the
  intent was narrower.
- Did not execute a live `--dry` smoke run against the real GeckoTerminal API — confidence in the
  live `?include=base_token` wiring and the 429/Retry-After handling comes from
  `tests/geckoterminal.test.ts`'s fixture-based coverage (shaped to match the brief's documented
  live-verified response shape) plus `runCycle.test.ts`'s fakes, not an actual end-to-end request
  against `api.geckoterminal.com`.
- The prefetch step iterates `pools` (the merged trending+new list) in whatever order
  `fetchPools`'s `Map`-based dedupe produces (trending-sourced entries first, then any
  new-pools-only entries, insertion order within each) — there's no explicit prioritization (e.g.,
  by liquidity/volume) of which uncached candidates get one of the scarce `PREFETCH_PER_CYCLE`
  slots. Acceptable for v1 (the brief doesn't ask for prioritization), but worth flagging if some
  tokens should be prioritized for prefetch over others.
- `tokenInfoCache`'s unbounded-growth characteristic (flagged in Task 12's report) is unchanged by
  raising the TTL to 6h — entries just live 24x longer before eviction-on-expiry-check, which
  slightly increases the cache's steady-state memory footprint for a long-running process. Still
  acceptable for v1 given the process only tracks pools it's actively posting/following.
