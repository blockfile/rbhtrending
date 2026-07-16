# Robinhood Chain Trending Bot

A Telegram "trending" feed bot for **Robinhood Chain** (EVM L2, chain ID `4663`) memecoins. It's a
high-coverage feed, not a strict filter: it posts tokens gaining traction as rich cards with a
security badge and red-flag list, then follows up with "up Nx" and dump alerts as the token moves.

This is a **separate project** from the Solana pump.fun scanner — different chain, different repo
(`d:\robinhood-trending`) — but it reuses the Solana bot's Telegram card/presentation layer.

## How it works

```
GMGN openapi market/rank poll (chain=robinhood, interval=1h, limit=100)
        │  ONE call returns every field a card needs: price/MC/liq/vol, holder count,
        │  top-10 %, ATH, honeypot, buy/sell tax, renounced, LP-lock %, verified,
        │  dev-hold %, bot-trader / insider / entrapment rates, smart-money / KOL / sniper counts
        ▼
   Trending gate (pipeline/trending.ts → passesGate)
        │  liquidityUsd ≥ minLiquidityUsd AND (volumeUsd ≥ minVolume1hUsd OR buys ≥ minBuyers1h)
        ▼
   Scoring (checks/assess.ts → assess)
        │  score 0-100, grade safe/warn/danger, red-flag list — all derived from the GMGN row
        ▼
   Telegram card (telegram.ts → formatCard) → post
        │  card photo = GMGN logo proxied via images.weserv.nl (gmgn.ai itself 403s Telegram's
        │  fetcher behind a Cloudflare challenge), else the DexScreener CDN; a failed image
        │  falls back to a text-only post. Buttons: Chart/Scan/Trade row + 📋 Copy CA
        │  (copy_text — reliable tap-to-copy on mobile, unlike the <code> address)
        ▼
   Tracker follow-ups (pipeline/trending.ts)
        up-Nx milestone alerts + dump-drawdown alerts, driven by the same polled market-cap
        reads — sent with the same token photo as the original card
```

**GMGN is the only data source.** There is no GeckoTerminal call and no on-chain RPC/EVM scanning
in the current bot — the earlier GeckoTerminal + `eth_call`-based security-scan design was fully
replaced by a single GMGN `market/rank` poll per cycle.

A single long-running Node process. State (seen/posted tokens, follow-up tracking) persists in
SQLite via `better-sqlite3`.

## Security badge & score

`checks/assess.ts` grades every GMGN row into a `⭐` score (0-100), a `🛡` grade
(`safe` / `warn` / `danger`), and a list of `⚠️` red flags — all computed locally from the fields
GMGN already returned, no extra calls.

On Robinhood chain every token launches through the same launchpad, so the classic security
fields come back identically "good" for the whole feed (renounced ✓, verified ✓, LP 95% locked,
0% tax, no honeypot) — a rubric weighted on those pinned ~every card at 100/100. The score
therefore starts at a **baseline of 88** and moves mainly on the signals that actually vary
between tokens; 100 now means "clean AND strongly backed", not just "no rug flags".

**Flags** (pushed in this order; the card joins them with " · "):

| Flag | Rule |
|---|---|
| `honeypot` | `is_honeypot` true |
| `sell tax N%` | sell tax > 10% |
| `LP not locked` | LP-lock % < 50% |
| `owner active` | not renounced |
| `unverified` | contract not open-source/verified |
| `top 10 owns N%` | top-10 holder share > 50% |
| `dev holds N%` | dev/team hold % > 15% |
| `wash trading` | GMGN's own wash-trading flag |
| `bots N%` | bot-trader share (`bot_degen_rate`) > 50% |
| `insiders N%` | insider/rat-trader supply (`rat_trader_amount_rate`) > 20% |
| `N snipers` | sniper count ≥ 20 |
| `-N% from ATH` | market cap below 20% of ATH (informational, no score hit — old ones are gate-filtered, so this marks young retraces) |

**Grade:** `danger` if honeypot OR sell tax > 30% OR LP-lock < 20% OR score < 40; else `warn` if
any flag fired OR score < 70; else `safe`.

**Score:** starts at the 88 baseline, then:

- *Fixed security penalties* (uniform on launchpad tokens, kept for the odd non-standard one):
  honeypot −80, not renounced −12, unverified −8, LP-lock < 20% −30 (else < 50% −15), sell tax
  > 30% −30 (else > 10% −15), wash trading −20, rug-ratio > 50% −20.
- *Proportional penalties* on the fields that vary (each is `perUnit × amount-over-floor`,
  rounded, capped): top-10 share 0.5/% over 20% (cap 30), dev hold 0.6/% over 2% (cap 20),
  bot traders 0.3/% over 20% (cap 15), insider supply 0.5/% (cap 15), entrapment 0.2/% over 40%
  (cap 10), snipers 0.25 each (cap 8), bundled supply 0.5/% over 5% (cap 5), holder count
  < 100 −5.
- *Depth bonuses*: smart money +0.3/wallet (cap +7), KOLs +0.2/wallet (cap +5) — max +12, so
  only a penalty-free token can reach 100.

Clamped to `0..100`.

**Coverage model:** the trending gate is about activity (liquidity/volume/buyers), not safety —
a flagged token still posts, with its warnings visible on the card. Nothing is silently hidden,
with two exceptions that never post: confirmed honeypots, and **dead bounces** — tokens older
than `minMcOfAthAgeHours` sitting below `minMcOfAthPct`% of their ATH, whose burst of bot/bounce
buys would otherwise satisfy the activity gate (GMGN's rank list happily re-lists such corpses).

## Startup behavior

- **Cold-start silent seed** (`pipeline/runCycle.ts`): on the very first run ever (`db.postCount()
  === 0`), every currently gate-passing token is silently marked as posted — no scoring, no
  formatting, no Telegram send — so the ~dozens of tokens already trending at boot don't flood the
  channel. From then on, only tokens that *newly* start trending are alerted.
- **Per-cycle post cap**: `trending.maxPostsPerCycle` (config.json) caps how many brand-new posts
  go out in a single poll cycle. Anything over the cap is simply picked up on a later cycle — it's
  still gate-passing and unposted, so nothing is lost, just throttled.
- **Trending gate** (`passesGate` in `pipeline/trending.ts`):
  `liquidityUsd ≥ trending.minLiquidityUsd AND (volumeUsd ≥ trending.minVolume1hUsd OR buys ≥
  trending.minBuyers1h)`.
- Tracked (already-posted) tokens skip the gate/cap entirely and are always fed a fresh
  market-cap read each cycle for milestone/dump follow-ups.

## Requirements

- Node.js ≥ 20
- A GMGN API key
- A Telegram bot token and a chat ID to post to

Runtime dependencies (`package.json`): `better-sqlite3` (state), `dotenv` (env loading). `ws` is
also listed as a dependency but isn't imported anywhere under `src/` — it appears to be an unused
leftover from before the on-chain WS listener was removed; don't read it as a live feature.

## Setup

1. **Get a GMGN API key:**
   ```
   npx gmgn-cli config
   ```
   generates a keypair and a creation link — open the link, then apply the issued key:
   ```
   npx gmgn-cli config --apply <key>
   ```
   The bot reads this from `GMGN_API_KEY` in `.env`.

2. **Copy `.env.example` to `.env`** and fill in real values:

   | Variable | Required | Notes |
   |---|---|---|
   | `GMGN_API_KEY` | yes | from `gmgn-cli` above |
   | `TELEGRAM_BOT_TOKEN` | yes | from BotFather |
   | `TELEGRAM_CHAT_ID` | yes | destination chat/channel; **for a channel this must be negative**, e.g. `-1004389601664` |
   | `RH_RPC_URL` / `RH_WS_URL` | no | legacy — the on-chain EVM client that used these was removed when GMGN took over; the bot boots fine without them |
   | `GECKOTERMINAL_API_KEY` | no | legacy — left over from the pre-GMGN GeckoTerminal source; unused |

3. **Review `config.json` thresholds** (all live values, no code changes needed to tune them):

   | Field | Meaning |
   |---|---|
   | `trending.minLiquidityUsd` | floor pool liquidity (USD) to be eligible to trend |
   | `trending.minVolume1hUsd` | 1h volume floor (either this or `minBuyers1h` must clear) |
   | `trending.minBuyers1h` | 1h buyer-count floor (either this or `minVolume1hUsd` must clear) |
   | `trending.pollSeconds` | how often the bot polls GMGN |
   | `trending.milestones` | multiples (e.g. `2,5,10,25,50,100`) that fire "up Nx" follow-ups |
   | `trending.dumpDrawdownPct` | drawdown off peak market cap that fires a dump follow-up |
   | `trending.maxPostsPerCycle` | cap on brand-new posts sent in one poll cycle |
   | `trending.minMcOfAthPct` | dead-bounce filter: once old enough, MC must be ≥ this % of ATH to post |
   | `trending.minMcOfAthAgeHours` | dead-bounce filter applies only to tokens older than this |
   | `followUp.windowMinutes` | how long a posted token stays tracked for follow-ups before its tracking window expires |
   | `followUp.liveEditSec` | reserved cadence for the (not-yet-wired) live-edit ticker — see Roadmap |
   | `buttons.chart` / `scan` / `trade` | toggle each inline button on the card (the 📋 Copy CA button is always on) |

## Running

```
npm install
npm run dry     # dry run — logs cards (and cold-start seed summary) to stdout, sends nothing to Telegram
npm start        # live — posts to the configured Telegram chat
```

Tests and typecheck:

```
npm test              # vitest run
npm run typecheck     # tsc --noEmit
```

For production, run it under **pm2** (or an equivalent process manager) as a single long-running
process — there's nothing to scale horizontally; SQLite state assumes one writer.

## Paid trending slots (⭐ promo)

Self-serve paid placement on a pinned **ROBINHOOD TRENDING** leaderboard, mirroring the Solana
trending-channel slot-menu model — but with visible ⭐ disclosure (paid rows are labelled; the
Solana channels' undisclosed-shill approach is a deliberate non-goal).

**Buyer flow:** DM the bot `/trend` → send the token CA (symbol resolves on-chain via
`eth_call symbol()`) → pick from the 3×3 inline menu (Top 3 / Top 8 / Top 12 × 3h / 6h / 24h)
→ the bot quotes the clean tier price and a **dedicated deposit address unique to that order**.
The payment watcher polls each pending order's deposit-address balance (`eth_getBalance` at
`latest − confirmations`) via `RH_RPC_URL`; once it holds the quoted amount the order
auto-activates: the buyer gets a DM, a **⭐ PROMOTED card** posts to the channel, the token takes
its purchased rank on the pinned leaderboard for the paid duration, and the deposit is **swept
into `promo.treasuryAddress`** (your main wallet). Unpaid quotes expire after
`promo.pendingMinutes`; expired slots free their rank automatically (and their last promoted
card is removed).

**Promoted card + bumps.** The promoted post is a full trending-style card — token logo image,
a `⭐ PROMOTED · #rank · time-left` banner, the same stats block as an organic alert, and a
prominent **🚀 Buy** button (GMGN trade page) alongside Chart / Scan / Copy-CA. If the token
isn't in the current GMGN feed that cycle, it falls back to a compact card so a post never fails.
While the slot is active the card **re-posts on a per-tier timer** (`tiers.*.bumpMinutes` —
Top 3 every 30 min, Top 8 every 60, Top 12 every 90) so it keeps resurfacing and re-notifying;
each bump deletes the previous one, so exactly **one** live promoted post exists per token at a
time. Paid posts always keep the ⭐ PROMOTED label — they are never disguised as organic picks.

**Per-order deposit wallets.** Each order's deposit address is derived from a single HD seed
(`PROMO_MNEMONIC` in `.env`) at path `m/44'/60'/0'/0/{index}`. The order → index → address →
private key mapping is written to `data/wallets.json`, so each deposit wallet is fully
self-contained (importable/sweepable on its own). ⚠️ **`wallets.json` therefore holds live
private keys** — it lives under gitignored `data/` so it is never committed, but treat it as
secret and back it up securely (losing it, if the seed is also lost, means losing any
un-swept deposits). All deposits gather into `promo.treasuryAddress`; sweeps retry every cycle
until confirmed, so funds are never stranded (a failed sweep just leaves the ETH in the deposit
address for the next attempt).

**Leaderboard:** one pinned message, live-edited every poll cycle — ⭐ paid slots hold their
ranks (Top 3 tier = ranks 1–3, Top 8 = 4–8, Top 12 = 9–12), all other ranks fill organically.
The organic pool is **not** GMGN's raw hotness order (which honeypots and wash campaigns game):
it runs through the same quality bar as the alerts — `rankOrganic` drops anything failing the
trending gate (honeypots, dead-bounces far below ATH, thin liquidity) or grading `danger`, then
sorts the rest by our own `assess()` score, so a rug can never take a top slot.

**Admin free listings.** Telegram user ids in `promo.adminChatIds` can comp a slot without
paying: run the same `/trend` flow and tapping any tier lists the token **free and instantly**
(no payment quote, no deposit wallet), bypassing sold-out. The comped slot behaves like any paid
one — ⭐-labelled, ranked, expiring on schedule. In a DM the chat id equals your Telegram user
id (get it from `@userinfobot`); an empty `adminChatIds` means nobody can comp.

**Admin delist.** An admin can pull a promoted token (e.g. it rugged) by DMing the bot
`/delist <token address>`: the slot leaves the leaderboard, its rank frees up, its live promoted
card is deleted from the channel, and the buyer is DM'd that it was removed. No refund is issued
automatically — that stays a manual call (you have the buyer's deposit address on file).

**To turn it on:**
1. Set `promo.treasuryAddress` in `config.json` to your main wallet, and `promo.enabled: true`.
2. Set `PROMO_MNEMONIC` in `.env` to a **fresh, dedicated** BIP39 seed phrase (this seed
   controls every deposit address — keep it secret and backed up).
3. Tune tier prices (`promo.tiers.*.prices` — duration-hours → ETH) and inventory (`slots`), and
   put your own Telegram user id in `promo.adminChatIds` so you can list your tokens free.
4. Make the bot a channel admin with pin rights (leaderboard pinning) and keep `RH_RPC_URL` set
   (payment detection + sweeping — promo disables itself without either the RPC or the seed).

**Operational notes:** payment is detected by balance ≥ the quoted price (overpayment counts;
underpayment does not and needs a manual refund). There is no escrow/refund flow, matching how
every service in this market operates. Sweeping leaves a small buffered gas reserve on each
deposit address; true dust is left behind rather than moved at a loss. Promo never runs in
`--dry` mode, and a promo failure never blocks organic alerts.

## Roadmap / notes

- **Live-card editing is not wired up in v1.** `Telegram.editCaption()` exists and `config.json`
  reserves `followUp.liveEditSec` for it, but `runCycle` only ever sends the original card plus
  separate follow-up messages — the original card is never edited in place. (The pinned promo
  leaderboard *is* live-edited.)
- This bot is entirely separate from the Solana pump.fun scanner in this account's other repo —
  different chain, different data source, independent process.
