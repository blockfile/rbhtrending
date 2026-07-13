# Robinhood Chain Trending Bot — v1 Design Spec

**Date:** 2026-07-13
**Status:** Approved design, pending implementation plan
**Repo:** `d:\robinhood-trending` (new, separate from the Solana `telebot` repo)
**Goal:** A Telegram "trending" channel bot for Robinhood Chain (EVM, chain 4663) memecoins. High-coverage feed of tokens gaining traction, each posted as a rich card with a GoPlus safety badge, plus "up Nx" and dump follow-ups and live-updating cards. Reuses the Solana bot's proven Telegram/presentation layer. Paid "Sponsored" placement is v2 (out of scope here, but the design must not preclude it).

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Phasing | Organic trending feed = v1; paid placement = v2 |
| Selectivity | **Coverage + safety badges** — post broadly, show a security verdict + red flags so subscribers self-filter (Solana Early Trending model), NOT a strict filter |
| Architecture | **Hybrid** — aggregator (GeckoTerminal) for discovery/data + EVM RPC (QuickNode or Alchemy) for the on-chain edge + **on-chain security** (GoPlus does NOT support chain 4663 — verified live 2026-07-13, "main chain is not supported") |
| Security | **On-chain, built by us**: honeypot sell-simulation via `eth_call` (impersonate a holder) + buy/sell tax measurement + lite heuristics (owner renounced, LP burned/locked, contract verified, top-holder %). No third-party security API — none covers RH Chain yet |
| RPC provider | Provider-agnostic: any EVM HTTP+WS endpoint for chain 4663 (user has QuickNode; add a Robinhood Chain endpoint. Alchemy not required) |
| Chain | Robinhood Chain, EVM, chain ID 4663, ETH gas, Uniswap-style DEX |
| Reuse | Telegram card/live-edit/follow-up/config/DB scaffolding from the Solana bot (chain-agnostic) |

## Architecture

```
Discovery ─┬─ GeckoTerminal API (poll new + trending pools for network 'robinhood')
           └─ Alchemy WS (Uniswap PairCreated logs → lowest-latency brand-new pools)
                 │  (dedupe by token address across both sources)
        Trending gate (activity thresholds in a rolling window)
                 │
        Enrich (parallel, each best-effort → '?' on failure):
           ├─ GeckoTerminal: MC/FDV, ATH, liquidity (reserve_usd), 1h volume, price, tx/buyers h1
           ├─ On-chain security (our own): honeypot sell-sim + buy/sell tax + owner renounced + LP burned/locked + top-holder %
           └─ RPC on-chain edge: fresh pool reserves (liq sanity), dev-wallet balance %
                 │
        Card (reused Telegram layer, EVM body) → post → live-edit ticker → Nx / dump follow-ups
```

Single long-running Node process. SQLite accumulates seen/posted/follow-up state.

## Components (`src/`, TypeScript, ESM, run via tsx — same conventions as the Solana repo)

| Module | Responsibility |
|---|---|
| `config.ts` | Load `.env` (RH_RPC_URL, RH_WS_URL, GECKOTERMINAL_API_KEY?, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) + `config.json` (thresholds); validate on boot |
| `sources/geckoterminal.ts` | REST client: `newPools()`, `trendingPools()`, `tokenInfo(addr)` for network `robinhood`; 5s timeout, retry, in-memory cache + central rate-limit (free tier ~30 req/min) |
| `chain/evm.ts` | EVM WS (`eth_subscribe` logs, topic0 = Uniswap `PairCreated`) with reconnect+backoff+watchdog; thin JSON-RPC (`eth_call`, `eth_getLogs`); ABI-lite encoders/decoders (no heavy web3 dep — hand-roll the few calls) |
| `checks/security.ts` | `securityScan(token, pool) → { honeypot, buyTaxPct, sellTaxPct, lpBurnedOrLocked, ownerRenounced, verified, topHolderPct, verdict: 'safe'|'warn'|'danger' } | 'unknown'`. Honeypot/tax via `eth_call` sell-simulation impersonating a holder through the Uniswap router; renounce via `owner()`; verified via Blockscout API; LP status via LP-token holder check |
| `pipeline/trending.ts` | Pure trending gate: takes pool activity → `{ trends: boolean }`; multiple-crossing detection (2X/5X/10X…) mirroring the Solana followups pattern |
| `pipeline/enrich.ts` | Orchestrates the three enrichment sources into a `TokenCard` (all fields `T | 'unknown'`) |
| `telegram.ts` | **Copied** from Solana bot; `formatCard` body rewritten for EVM fields (+ 🛡 security line, fake-vol); `send`/`editCaption`/buttons/SendResult unchanged |
| `followups.ts` + live-card ticker | **Copied**; drive off GeckoTerminal price polls instead of a trade stream (EVM has no free trade WS equiv — poll MC every N sec) |
| `db/index.ts` | **Copied pattern**; tables: `tokens` (address, symbol, first_seen, posted, outcome), `posts` (message_id, posted_at), follow-up state |
| `index.ts` | Wire discovery → gate → enrich → post → follow-ups; intervals; graceful shutdown; latency logging |

## Trending trigger + card

- **Trends when** a pool crosses, in a rolling window (all config, defaults): `liquidityUsd ≥ 5000` AND (`volume1hUsd ≥ 10000` OR `buyers1h ≥ 30`). Posted once per token (dedupe by address); subsequent milestone crossings (`multiples: [2,5,10,25,50,100]`) fire "up Nx" follow-ups. A hard drawdown fires a ⚠️ dump follow-up (reuse Solana logic).
- **Card layout** (reused reference style):
  ```
  🔥 $SYM • Name
  🛡 Security: ✅  (honeypot ❌ · tax 2/2% · LP 🔒 · renounced ✅)
  📈 Now: $X • N.NX            ← live-edited
  💰 MC: $X • ⇡ ATH $Y
  💧 Liq: $Z
  📊 Vol 1h: $V • 🪙 fake ~P%
  👥 Holders: H
  🏆 Top holder: T%
  🐦 X ✅ | TG ❌ | Web ✅
  <contract 0x… tap-copy>
  [📊 Chart] [🔍 Scan] [💱 Trade]
  ```
  `🛡 Security` verdict from our on-chain scan: `danger` (honeypot / can't sell / sell-tax > 30% / LP not burned-or-locked) → 🧨, `warn` (moderate tax 10–30% / owner not renounced / top-holder > 25%) → ⚠️, else ✅. Any field that can't be determined renders `?` and never upgrades the verdict toward safe.

## Data source verification (status as of 2026-07-13)

- [x] **GeckoTerminal `robinhood` network — CONFIRMED LIVE.** `new_pools` (20 items) and `trending_pools` (20 items) return rich data: `volume_usd.h24`, `reserve_in_usd` (liquidity), `transactions.h1 = {buys,sells,buyers,sellers}`, `fdv_usd`, `base_token_price_usd`, `pool_created_at`. This is discovery + trending gate + most card data.
- [x] **GoPlus — CONFIRMED UNSUPPORTED** for chain 4663 ("The main chain is not supported"). Security is built on-chain instead (no third-party dependency).
- [ ] **Build-time:** Robinhood Chain Uniswap **router + WETH addresses** and factory `PairCreated` topic0 (Dexscreener shows `… / WETH on Robinhood / Uniswap`; get exact addresses from a live pair's tx or the RH/Uniswap docs). Needed for the WS pair listener and the sell-simulation.
- [ ] **Build-time:** confirm `eth_call` with a `from` (holder) override simulates a sell on this RPC (standard, but verify against the chosen provider).

## Error handling

- Every API/RPC call: timeout-bounded, retry, degrade to `'unknown'`/skip — never crash (Solana doctrine).
- Alchemy WS: reconnect with backoff + 120s staleness watchdog.
- GeckoTerminal rate limit: central limiter + cache; on 429 back off, don't drop the pipeline.
- A token that can't be security-scanned still posts with `🛡 Security: ?` (coverage model — we show uncertainty, we don't hide the token).

## Testing

- Pure/unit (TDD): trending gate, GoPlus verdict mapping, `formatCard` (all fields + unknowns + security tiers), milestone follow-up crossings, fake-vol calc.
- Thin I/O wrappers (geckoterminal/alchemy/goplus clients): light tests with injected fetch; live smoke via a dry run against Robinhood Chain.
- Reused modules keep their existing tests, ported.

## v2 (out of scope, must-not-preclude)

Paid placement: a submission + payment flow (project pays ETH to a controlled wallet), on-chain tx verification, a `posts` boost queue, and a labeled **⭐ Sponsored** card variant. The card/DB/telegram design leaves room (a `sponsored` flag on posts) but no v2 code ships in v1.

## Out of scope (YAGNI)

- Paid placement (v2); custom bundle/sniper on-chain tracing (aggregator depth is enough for a trending card); multi-chain; a web dashboard.
