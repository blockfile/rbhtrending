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

export interface AppConfig {
  trending: TrendingConfig;
  followUp: FollowUpConfig;
  buttons: ButtonsConfig;
}

export interface Secrets {
  rhRpcUrl: string;
  rhWsUrl: string;
  geckoTerminalApiKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  gmgnApiKey: string;
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
