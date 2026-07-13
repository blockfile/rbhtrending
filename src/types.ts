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
