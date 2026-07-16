export interface TrendingConfig {
  minLiquidityUsd: number;
  minVolume1hUsd: number;
  minBuyers1h: number;
  pollSeconds: number;
  milestones: number[];
  dumpDrawdownPct: number;
  /** Max brand-new posts sent per runCycle call (Task G4) — throttles bursts; excess
   * gate-passing tokens are simply picked up again on a later cycle. */
  maxPostsPerCycle: number;
  /** Dead-bounce filter: once a token is older than `minMcOfAthAgeHours`, its market cap must
   * be at least `minMcOfAthPct`% of its ATH to post — an old token far below ATH is a rug
   * corpse twitching on bot buys, not a new trend. Young tokens are exempt because a retrace
   * off the launch spike is normal. */
  minMcOfAthPct: number;
  minMcOfAthAgeHours: number;
}

export interface FollowUpConfig {
  windowMinutes: number;
  liveEditSec: number;
}

export interface ButtonsConfig {
  chart: boolean;
  scan: boolean;
  trade: boolean;
}

export type PromoTierKey = 'top3' | 'top8' | 'top12';

export interface PromoTierConfig {
  /** Highest (worst) leaderboard rank this tier can occupy — top3 covers ranks 1..3, top8
   * covers 4..8 (everything above the previous tier's maxRank), top12 covers 9..12. */
  maxRank: number;
  /** Sellable inventory: how many concurrent orders (pending + active) this tier accepts. */
  slots: number;
  /** Duration hours ("3" | "6" | "24") → price in ETH on Robinhood Chain. */
  prices: Record<string, number>;
  /** Minutes between re-posts ("bumps") of an active slot's promoted card — higher tiers bump
   * more often (e.g. top3 30, top8 60, top12 90). */
  bumpMinutes: number;
}

/** Paid ⭐-promoted leaderboard placement. Each order gets its own deposit wallet (derived from
 * the `PROMO_MNEMONIC` HD seed); the buyer pays the clean tier price in native ETH on Robinhood
 * Chain, the balance is watched via RH_RPC_URL, then swept into `treasuryAddress` (your main
 * wallet). */
export interface PromoConfig {
  enabled: boolean;
  /** Main wallet that received deposits are swept into. */
  treasuryAddress: string;
  confirmations: number;
  leaderboardSize: number;
  /** Minutes an unpaid order holds its slot reservation before auto-cancelling. */
  pendingMinutes: number;
  /** Telegram user ids allowed to comp a free listing (in a DM, chat id == user id). Empty =
   * no free listings. Get your id from @userinfobot. */
  adminChatIds: number[];
  tiers: Record<PromoTierKey, PromoTierConfig>;
}

export interface AppConfig {
  trending: TrendingConfig;
  followUp: FollowUpConfig;
  buttons: ButtonsConfig;
  promo: PromoConfig;
}

export interface Secrets {
  rhRpcUrl: string;
  rhWsUrl: string;
  geckoTerminalApiKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  gmgnApiKey: string;
  /** HD seed phrase for deriving per-order deposit wallets (promo). Empty unless promo is used. */
  promoMnemonic: string;
}

/**
 * Full per-token data from a single GMGN `market/rank` row (Task G1) — price/mc/liq/vol,
 * holders, top-10 concentration, ATH, honeypot/tax/renounced/LP-lock/verified security flags,
 * and smart-money/KOL/sniper depth counts. The former GeckoTerminal-derived PoolActivity/
 * TokenCard/Security types were removed in Task G5 once GMGN fully replaced that pipeline.
 */
export interface GmgnToken {
  address: string;
  name: string;
  symbol: string;
  logo?: string;
  priceUsd: number;
  priceChange1hPct: number;
  volumeUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  athMarketCapUsd: number;
  swaps: number;
  buys: number;
  sells: number;
  holderCount: number;
  top10Pct: number;
  createdAt: number;
  twitter?: string;
  telegram?: string;
  website?: string;
  // security
  honeypot: boolean;
  buyTaxPct: number;
  sellTaxPct: number;
  renounced: boolean;
  verified: boolean;
  lpLockedPct: number;
  devHoldPct: number;
  rugRatioPct: number;
  burnPct: number;
  // depth / social proof
  smartMoneyCount: number;
  kolCount: number;
  sniperCount: number;
  bundlerRatePct: number;
  washTrading: boolean;
  hotLevel: number;
  // trade quality — the fields that actually vary between tokens on Robinhood chain, where the
  // launchpad standardizes the classic security flags (renounced/verified/LP-lock/taxes) to
  // identical "good" values and they carry no signal
  entrapmentPct: number;
  ratTraderPct: number;
  botDegenPct: number;
}
