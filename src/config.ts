import 'dotenv/config';
import { readFileSync } from 'node:fs';
import type { AppConfig, Secrets } from './types';

export function loadConfig(path = 'config.json'): AppConfig {
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as AppConfig;

  const requiredNumeric: Array<[string, unknown]> = [
    ['trending.minLiquidityUsd', cfg.trending?.minLiquidityUsd],
    ['trending.minVolume1hUsd', cfg.trending?.minVolume1hUsd],
    ['trending.minBuyers1h', cfg.trending?.minBuyers1h],
    ['trending.pollSeconds', cfg.trending?.pollSeconds],
    ['trending.dumpDrawdownPct', cfg.trending?.dumpDrawdownPct],
    ['trending.maxPostsPerCycle', cfg.trending?.maxPostsPerCycle],
    ['security.sellTaxDangerPct', cfg.security?.sellTaxDangerPct],
    ['security.sellTaxWarnPct', cfg.security?.sellTaxWarnPct],
    ['security.topHolderWarnPct', cfg.security?.topHolderWarnPct],
    ['followUp.windowMinutes', cfg.followUp?.windowMinutes],
    ['followUp.liveEditSec', cfg.followUp?.liveEditSec],
  ];

  for (const [name, v] of requiredNumeric) {
    if (typeof v !== 'number') throw new Error(`config.json missing numeric field: ${name}`);
  }

  if (!Array.isArray(cfg.trending?.milestones) || cfg.trending.milestones.length === 0 ||
      cfg.trending.milestones.some((m) => typeof m !== 'number')) {
    throw new Error('config.json missing number array: trending.milestones');
  }

  if (!cfg.buttons || typeof cfg.buttons.chart !== 'boolean' ||
      typeof cfg.buttons.scan !== 'boolean' ||
      typeof cfg.buttons.trade !== 'boolean') {
    throw new Error('config.json missing buttons config (chart, scan, trade as booleans)');
  }

  return cfg;
}

export function loadSecrets(env: Record<string, string | undefined> = process.env): Secrets {
  const missing: string[] = [];
  const get = (k: string): string => {
    const v = env[k];
    if (!v) missing.push(k);
    return v ?? '';
  };

  const secrets = {
    rhRpcUrl: get('RH_RPC_URL'),
    rhWsUrl: get('RH_WS_URL'),
    telegramBotToken: get('TELEGRAM_BOT_TOKEN'),
    telegramChatId: get('TELEGRAM_CHAT_ID'),
    geckoTerminalApiKey: env['GECKOTERMINAL_API_KEY'] ?? '', // optional
    gmgnApiKey: get('GMGN_API_KEY'),
  };

  if (missing.length) {
    throw new Error(`Missing required values in .env: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
  }

  return secrets;
}
