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
    ['trending.minMcOfAthPct', cfg.trending?.minMcOfAthPct],
    ['trending.minMcOfAthAgeHours', cfg.trending?.minMcOfAthAgeHours],
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

  validatePromo(cfg);

  return cfg;
}

function validatePromo(cfg: AppConfig): void {
  const p = cfg.promo;
  if (!p || typeof p.enabled !== 'boolean') {
    throw new Error('config.json missing promo config (enabled as boolean)');
  }
  for (const [name, v] of [
    ['promo.confirmations', p.confirmations],
    ['promo.leaderboardSize', p.leaderboardSize],
    ['promo.pendingMinutes', p.pendingMinutes],
  ] as Array<[string, unknown]>) {
    if (typeof v !== 'number') throw new Error(`config.json missing numeric field: ${name}`);
  }
  for (const key of ['top3', 'top8', 'top12'] as const) {
    const t = p.tiers?.[key];
    if (!t || typeof t.maxRank !== 'number' || typeof t.slots !== 'number' ||
        !t.prices || Object.keys(t.prices).length === 0 ||
        Object.values(t.prices).some((price) => typeof price !== 'number' || price <= 0)) {
      throw new Error(`config.json missing promo tier: promo.tiers.${key} (maxRank, slots, positive prices)`);
    }
  }
  if (p.enabled && !/^0x[0-9a-fA-F]{40}$/.test(p.paymentAddress)) {
    throw new Error('config.json promo.enabled requires a valid promo.paymentAddress (0x…)');
  }
}

export function loadSecrets(env: Record<string, string | undefined> = process.env): Secrets {
  const missing: string[] = [];
  const get = (k: string): string => {
    const v = env[k];
    if (!v) missing.push(k);
    return v ?? '';
  };

  const secrets = {
    // No longer required (Task G5 removed the on-chain Evm client) — read as optional strings
    // so a deploy without an RPC still boots.
    rhRpcUrl: env['RH_RPC_URL'] ?? '',
    rhWsUrl: env['RH_WS_URL'] ?? '',
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
