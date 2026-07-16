# Sol-style promoted slots — design

Make paid ⭐ trending slots deliver the engagement of Sol Early Trending: a rich card, periodic
re-posts ("bumps"), and a one-tap buy button — while keeping honest ⭐ PROMOTED disclosure.

## Goals

1. **Rich promoted card** — a full trending-style card (logo image + MC/liq/vol/holders/security
   stats) headed `⭐ PROMOTED · #rank`, instead of the current bare 2-liner.
2. **Periodic bumps** — while a slot is active, its card re-posts on a per-tier timer so it
   resurfaces in the feed and re-notifies subscribers.
3. **Buy button** — a `🚀 Buy` button linking to the token's GMGN trade page.

Non-goal (deliberate): hiding that a slot is paid. Promoted posts keep the `⭐ PROMOTED` label.

## Behaviour

- **Cadence (per tier, config-tunable):** Top 3 = 30 min, Top 8 = 60 min, Top 12 = 90 min.
- **Bump = fresh post**, not an edit, so it re-notifies. The **previous** bump message is
  **deleted** when the next posts, so exactly one live promoted post exists per token at a time.
- **Activation is the first bump** — the card posts immediately when the slot goes live.
- **Card data:** looked up from the current raw GMGN feed by address. If the token isn't in the
  feed that cycle, fall back to a compact card (symbol + rank + buttons, no stats) so a bump
  never fails.
- Bumps stop automatically when the slot expires (only active orders are bumped).

## Data flow

`promo.tick` receives **two** token lists: the score-ranked organic pool (for the leaderboard,
as today) and the **raw** GMGN list (indexed by address for promoted-card stats). This keeps
`PromoService` decoupled from `TrendingConfig` — the ranking still happens in `index.ts`.

## Changes

- **config/types:** `PromoTierConfig.bumpMinutes` (30/60/90 defaults); validated in `config.ts`.
- **db:** `orders.last_bumped_at`, `orders.bump_msg_id` (both nullable) + auto-migration;
  `OrderRow` fields; `recordBump(id, now, msgId)`.
- **telegram:** `deleteMessage(messageId)`.
- **promo/leaderboard (or new formatter):** `formatPromoCard(order, token?, assessment?, now)`
  → `{ text, photoUrl?, buttons }` with the `🚀 Buy` / Chart / Scan / Copy-CA keyboard.
- **promo/service:** `tick(organic, allTokens, now)`; `activate` posts the rich card as the
  first bump; new `bumpActive` step re-posts due orders and deletes the prior message.
- **index.ts:** pass both lists to `promo.tick`.

## Testing

TDD per unit: config validation + fixtures, db columns/migration/recordBump, the promo-card
formatter (rich + compact fallback + buy button), and service bump logic (due/not-due, delete
prior, first-bump-on-activate). Full suite + typecheck green before done.
