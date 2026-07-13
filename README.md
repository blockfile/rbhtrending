# Robinhood Chain Trending Bot

A Telegram "trending" feed bot for **Robinhood Chain** (EVM L2, chain ID `4663`) memecoins. It's a
high-coverage feed, not a strict filter: it posts tokens gaining traction as rich cards with an
on-chain security badge, then follows up with "up Nx" and dump alerts as the token moves.

This is a **separate project** from the Solana pump.fun scanner — different chain, different repo
(`d:\robinhood-trending`) — but it reuses the Solana bot's Telegram card/presentation layer.

## How it works

```
GeckoTerminal poll (trending + new pools, network 'robinhood')
        │  discovery + market data: liquidity, 1h volume, buyers, FDV, price
        ▼
   Trending gate (pipeline/trending.ts)
        │  liquidityUsd ≥ floor AND (volume1hUsd ≥ floor OR buyers1h ≥ floor)
        ▼
   On-chain enrichment (checks/security.ts, checks/blockscout.ts)
        │  security scan via EVM RPC (eth_call) + Blockscout verification
        ▼
   Telegram card (telegram.ts) → post
        │
        ▼
   Tracker follow-ups (pipeline/trending.ts)
        up-Nx milestone alerts + dump-drawdown alerts, driven by polled FDV reads
```

A single long-running Node process. State (seen/posted tokens, follow-up tracking) persists in
SQLite via `better-sqlite3`. There's no live-caption editing or WS listener in v1 — see
[Known limitations](#known-limitations--v11-roadmap).

## Security model (v1 "Option A")

Robinhood Chain has **no standard Uniswap router** exposing `getAmountsOut` / a swap function, so
there's no sell-simulation to run a honeypot or buy/sell-tax check through. GoPlus and other
third-party security APIs don't support chain 4663 either. So v1's `🛡 Security` badge is built
entirely from on-chain checks we run ourselves via `eth_call`:

| Signal | How it's checked |
|---|---|
| **Owner renounced** | `owner()` call — renounced if it resolves to the zero/dead address (or reverts, treated as renounced) |
| **LP burned / locked** | LP-token (pair) balance held at burn addresses ≥ ~99% of total supply |
| **Contract verified** | Blockscout (`robinhoodchain.blockscout.com`) verified-source lookup |
| **Transferability** | Self-transfer simulation: impersonates a real recent holder and `eth_call`s a transfer of half their balance to the dead address — a revert is a hard "this token can't be moved" signal, substituting for a real honeypot check |

**Honeypot detection and buy/sell tax are NOT measured in v1** — they're always shown as
"not measured" rather than a stale or fake ✅. A real sell-tax simulator is planned for v1.1 (see
below).

**Coverage model:** every field that can't be determined renders as `?`, and an unknown field
*never* upgrades the badge toward "safe" — `transferable` and `lpBurnedOrLocked` are the two
critical checks; either being unknown caps the verdict at `warn`.

## Requirements

- Node.js ≥ 20
- An EVM RPC endpoint (HTTP + WS) for Robinhood Chain, chain ID `4663` (e.g. QuickNode, Alchemy)
- A Telegram bot token and a chat ID to post to

Runtime dependencies are intentionally minimal — `ws`, `better-sqlite3`, `dotenv`. There's no
web3/ethers dependency; the few EVM calls this bot needs (`eth_call`, ABI encode/decode) are
hand-rolled in `src/chain/`.

## Setup

1. Install dependencies:
   ```
   npm install
   ```
2. Copy `.env.example` to `.env` and fill in real values:

   | Variable | Required | Notes |
   |---|---|---|
   | `RH_RPC_URL` | yes | HTTP RPC endpoint for Robinhood Chain |
   | `RH_WS_URL` | yes | WS RPC endpoint for Robinhood Chain |
   | `TELEGRAM_BOT_TOKEN` | yes | from BotFather |
   | `TELEGRAM_CHAT_ID` | yes | destination chat/channel; **for a channel this must be negative**, e.g. `-1004389601664` |
   | `GECKOTERMINAL_API_KEY` | no | optional, raises GeckoTerminal's free rate limit |

3. Review `config.json` thresholds (all live values, no code changes needed to tune them):

   | Field | Meaning |
   |---|---|
   | `trending.minLiquidityUsd` | floor pool liquidity (USD) to be eligible to trend |
   | `trending.minVolume1hUsd` | 1h volume floor (either this or buyers1h must clear) |
   | `trending.minBuyers1h` | 1h unique-buyer floor (either this or volume1h must clear) |
   | `trending.pollSeconds` | how often the bot polls GeckoTerminal |
   | `trending.dumpDrawdownPct` | drawdown off peak FDV that fires a dump follow-up |
   | `trending.milestones` | multiples (e.g. `2,5,10,25,50,100`) that fire "up Nx" follow-ups |
   | `security.sellTaxDangerPct` / `sellTaxWarnPct` | reserved thresholds for the v1.1 tax simulator |
   | `security.topHolderWarnPct` | top-holder % above which the badge escalates to `warn` |
   | `followUp.windowMinutes` | how long a posted token stays tracked for follow-ups |
   | `followUp.liveEditSec` | reserved cadence for the (not-yet-wired) live-edit ticker |
   | `buttons.chart` / `scan` / `trade` | toggle each inline button on the card |

## Running

```
npx tsx src/index.ts --dry   # dry run — logs cards to stdout, sends nothing to Telegram
npx tsx src/index.ts         # live — posts to the configured Telegram chat
```

`npm run dry` and `npm start` are shortcuts for the same two commands.

Tests and typecheck:

```
npx vitest run
npm run typecheck
```

For production, run it under **pm2** (or an equivalent process manager) as a single long-running
process — there's nothing to scale horizontally; SQLite state assumes one writer.

## Known limitations / v1.1 roadmap

- **Verified badge depends on Blockscout** (`robinhoodchain.blockscout.com`), which may throttle
  some IPs — on a throttled/failed lookup the badge degrades to `?`, it does not guess.
- **LP-lock detection only recognizes burn-to-dead-address.** LP sent to a third-party locker
  contract is not detected and shows `?`, not "locked".
- **Holders, ATH, and social links (X/Telegram/website) are not yet enriched** — the card fields
  exist but no pipeline stage populates them yet.
- **No live-caption editing and no WS pair-listener in v1** — discovery is poll-only via
  GeckoTerminal; the original posted card is static (follow-ups are separate messages, not edits
  to the original).
- **Paid "Sponsored" placement is v2** — out of scope for this bot as it stands.
- **A full honeypot/buy-sell-tax simulator is planned for v1.1.** `eth_call` state overrides are
  confirmed supported on this chain's RPC, which is what a real simulator would need.
