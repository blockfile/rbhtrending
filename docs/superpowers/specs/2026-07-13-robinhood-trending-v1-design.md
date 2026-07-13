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
| Architecture | **Hybrid** — aggregator (GeckoTerminal) for discovery/data + Alchemy on-chain for a latency/custom-metric edge + GoPlus for security |
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
           ├─ GeckoTerminal: MC, ATH, liquidity, 1h volume, price, holders
           ├─ GoPlus Token Security: honeypot, buy/sell tax, LP locked/burned, ownership renounced, top-holder %
           └─ Alchemy on-chain edge: fresh pool reserves (liq sanity), swap velocity, dev-wallet balance %
                 │
        Card (reused Telegram layer, EVM body) → post → live-edit ticker → Nx / dump follow-ups
```

Single long-running Node process. SQLite accumulates seen/posted/follow-up state.

## Components (`src/`, TypeScript, ESM, run via tsx — same conventions as the Solana repo)

| Module | Responsibility |
|---|---|
| `config.ts` | Load `.env` (ALCHEMY_RPC_URL, ALCHEMY_WS_URL, GECKOTERMINAL_API_KEY?, GOPLUS keys?, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) + `config.json` (thresholds); validate on boot |
| `sources/geckoterminal.ts` | REST client: `newPools(network)`, `trendingPools(network)`, `tokenData(addr)`; 5s timeout, retry, in-memory cache + rate-limit (free tier ~30 req/min) |
| `sources/alchemy.ts` | EVM WS (`eth_subscribe` logs, topic0 = Uniswap `PairCreated`/`PoolCreated`) with reconnect+backoff+watchdog; thin JSON-RPC (`eth_call` for reserves, `eth_getBalance`/ERC-20 `balanceOf` for dev %) |
| `checks/goplus.ts` | `securityScan(addr) → { honeypot, buyTaxPct, sellTaxPct, lpLockedOrBurned, ownerRenounced, topHolderPct, verdict: 'safe'|'warn'|'danger' } | 'unknown'` |
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
  `🛡 Security` maps from GoPlus: `danger` (honeypot/unsellable/owner-not-renounced-and-high-tax) → 🧨, `warn` (moderate tax / LP not locked / high top-holder) → ⚠️, else ✅. Unknown fields render `?`.

## Data source verification (build-time, before wiring)

- [ ] GeckoTerminal network slug for Robinhood Chain (likely `robinhood`) + confirm `new_pools`/`trending_pools` return data.
- [ ] GoPlus `token_security` supports chain 4663 (GoPlus is multi-EVM; verify the chain-id param). Fallback: honeypot.is or on-chain sell-simulation if not.
- [ ] Alchemy WS on Robinhood Chain + the correct Uniswap factory address + `PairCreated` topic0 (Dexscreener shows Uniswap on RH; confirm v2 vs v3 factory).

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
