export interface PoolActivity {
  address: string;
  symbol: string;
  name: string;
  liquidityUsd: number;
  volume1hUsd: number;
  buyers1h: number;
  priceUsd: number;
  fdvUsd: number;
  poolAddress: string;
  createdAt: number;
  /** Free per-token logo from the trending/new-pools `?include=base_token` sideload (Task 13
   * Part A) — no extra network call. Best-effort: absent when GeckoTerminal has no logo (or only
   * the 'missing.png' placeholder) for this token. */
  imageUrl?: string;
}

export interface Security {
  sellTaxPct: number | 'unknown';
  topHolderPct: number | 'unknown';
  riskLevel: 'safe' | 'warn' | 'danger' | 'unknown';
  // Richer on-chain security detail (Task 6's securityScan). Optional because that scan isn't
  // wired in yet; the Telegram card renders '?' for anything absent and never lets a missing
  // sub-check upgrade the displayed verdict toward "safe".
  honeypot?: boolean | 'unknown';
  buyTaxPct?: number | 'unknown';
  lpBurnedOrLocked?: boolean | 'unknown';
  ownerRenounced?: boolean | 'unknown';
  // Blockscout verified-source flag (Task 6's securityScan). Same degrade rule as the rest of
  // this block: absent/'unknown' never upgrades the displayed verdict toward "safe".
  verified?: boolean | 'unknown';
  // v1 Option-A transferability probe (Task 6c): impersonates a real holder and eth_calls a
  // self-transfer — a revert is a hard "can't move the token" signal. Substitutes for the
  // honeypot/tax simulation this chain can't run (no standard router). Same degrade rule.
  transferable?: boolean | 'unknown';
}

export interface TokenCard {
  address: string;
  symbol: string;
  name: string;
  liquidityUsd: number | 'unknown';
  volume1hUsd: number | 'unknown';
  buyers1h: number | 'unknown';
  priceUsd: number | 'unknown';
  fdvUsd: number | 'unknown';
  poolAddress: string;
  createdAt: number;
  security?: Security;
  // Enrichment fields no current source produces yet (holders/ATH/fake-volume/socials need a
  // pipeline stage beyond Tasks 1-7). Optional so the Telegram card layer can render them ('?'
  // when unknown, omitted where the brief calls for that) without blocking on later tasks.
  athUsd?: number | 'unknown';
  holders?: number | 'unknown';
  fakeVolumePct?: number | 'unknown';
  twitter?: string;
  telegram?: string;
  website?: string;
  /** GeckoTerminal token-info logo, and its 0-100 trust rating (Task 12). */
  imageUrl?: string;
  gtScore?: number;
  /** Present only while a live-edit ticker is driving this card (see followUp.liveEditSec). */
  live?: { nowUsd: number; multiple: number };
}

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

export interface SecurityConfig {
  sellTaxDangerPct: number;
  sellTaxWarnPct: number;
  topHolderWarnPct: number;
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
  security: SecurityConfig;
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
 * Full per-token data from a single GMGN `market/rank` row (Task G1). Replaces the
 * GeckoTerminal-derived PoolActivity/TokenCard/Security trio for the data GMGN can provide
 * directly — price/mc/liq/vol, holders, top-10 concentration, ATH, honeypot/tax/renounced/
 * LP-lock/verified security flags, and smart-money/KOL/sniper depth counts. The old types are
 * left in place until a later task retires GeckoTerminal + on-chain scanning.
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
}
