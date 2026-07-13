# Task G3 report — rewire the pipeline to GMGN

Status: done.

## What changed
- `src/pipeline/trending.ts`: added `passesGate(t: GmgnToken, cfg: TrendingConfig): boolean`
  (liquidity floor + volume-or-buyers floor, reading `GmgnToken.volumeUsd`/`buys`). Left `trends()`
  (the `PoolActivity` version) in place — still used by `trending.test.ts` and the still-live
  GeckoTerminal-era code.
- `src/pipeline/runCycle.ts`: full rewrite. Deleted the `tokenCardToGmgnToken` adapter, all
  GeckoTerminal/enrich/securityScan usage, `PREFETCH_PER_CYCLE`, `INFO_GRACE_MS`,
  `hasFreshTokenInfo`/`firstSeen` post-gate, and the `GeckoLike` interface. New shape: one
  `deps.gmgn.trending('1h', 100)` call per cycle; for each returned `GmgnToken`: `recordSeen` →
  if tracked, `tracker.onUpdate` → follow-up posts (never throws out) → else if `passesGate` &&
  not already posted && `tracker.shouldPost`, assess/formatCard/buildButtons and send with
  `photoUrl: t.logo`, `recordPost` + `markPosted` on success (a failed send is *not* marked
  tracked, so it's retried next cycle — matches the brief's pseudocode `continue` before
  `markPosted`). Sweep loop (window-expiry, log-only) kept unchanged. New `GmgnLike`/`RunCycleDeps`
  interfaces; `gmgn.trending` itself wrapped in its own try/catch even though `GmgnClient` is
  already best-effort, for interface-contract safety with other implementations/fakes.
- `src/index.ts`: constructs `new GmgnClient(secrets.gmgnApiKey)`; removed `GeckoTerminal`, `Evm`,
  `securityScan`, `isVerified`, `recentHolders`, `EXPLORER_BASE` wiring/imports. `RunCycleDeps` now
  `{ gmgn, db, telegram, tracker, cfg, dry }`. Kept: DB path resolution, `setInterval`
  (`cfg.trending.pollSeconds`), the re-entrancy guard, the immediate first tick, SIGINT/SIGTERM
  graceful shutdown (`db.close()`; no `evm.close()` — no on-chain client anymore).
- `tests/runCycle.test.ts`: rewritten with a fake `gmgn: GmgnLike` (`trending()` returning
  hand-built `GmgnToken[]`), fake telegram, in-memory `Db`, real `Tracker`. Covers: gate-passing
  unposted token posts with `photoUrl` = logo and gets recorded; a flat token fails the gate and
  never posts; no re-post on a second cycle; an "up" follow-up on a tracked token doubling market
  cap; a "dump" follow-up on a >50% drawdown off peak; `--dry` sends nothing and never calls
  `recordPost` but still records seen + marks tracked; `--dry` suppresses follow-up sends too; a
  throwing `gmgn.trending()` degrades to an empty cycle rather than crashing.

## Left untouched (per brief — later cleanup task removes these)
`src/sources/geckoterminal.ts`, `src/checks/{security,blockscout}.ts`, `src/pipeline/enrich.ts`,
`src/chain/{evm,abi,holders,constants}.ts` and their tests — still compiling, still passing, no
longer referenced from the live pipeline (`index.ts`/`runCycle.ts`).

## Verify
- `npx vitest run` — 15 files, 265 tests, all green.
- `npm run typecheck` — clean, exit 0.
- No live bot run. No `.env` read or printed.

## Commit
`feat: rewire pipeline to GMGN trending (one call, full data)`
