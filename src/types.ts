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
}
