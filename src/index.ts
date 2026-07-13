import { loadConfig, loadSecrets } from './config';
import type { AppConfig } from './types';
import { Db } from './db/index';
import { GeckoTerminal } from './sources/geckoterminal';
import { Evm } from './chain/evm';
import { Telegram } from './telegram';
import { Tracker } from './pipeline/trending';
import { securityScan } from './checks/security';
import { isVerified } from './checks/blockscout';
import { recentHolders } from './chain/holders';
import { EXPLORER_BASE } from './chain/constants';
import { log } from './logger';
import { runCycle, type RunCycleDeps } from './pipeline/runCycle';

const dry = process.argv.includes('--dry');

const cfg = loadConfig();
const secrets = loadSecrets();

// `dbPath` isn't a validated config.json field (task-10-brief.md: "don't add it to the
// validator") — read it loosely and fall back to the default data location.
const dbPath = (cfg as AppConfig & { dbPath?: string }).dbPath ?? 'data/robinhood.db';

const db = new Db(dbPath);
const gecko = new GeckoTerminal({ apiKey: secrets.geckoTerminalApiKey });
const evm = new Evm(secrets.rhRpcUrl, secrets.rhWsUrl);
const telegram = new Telegram(secrets.telegramBotToken, secrets.telegramChatId);
const tracker = new Tracker(cfg.trending, cfg.followUp);

// v1 discovery is POLL-based via GeckoTerminal (trendingPools/newPools) — `evm` is used only
// for the eth_call/eth_getLogs security probes below. We deliberately do NOT call
// evm.connect(): the WS PairCreated listener is a v1.1 feature (see task-10-brief.md).
// Live-caption editing of the originally posted card is also deferred to v1.1 — v1 delivers
// the original trending card plus separate follow-up posts only.
const securityScanDep = (token: string, pool: string) =>
  securityScan(
    {
      call: (to, data, from) => evm.call(to, data, from),
      isVerified: (addr) => isVerified(addr, EXPLORER_BASE),
      recentHolders: (t) => recentHolders(evm, t),
    },
    token,
    pool,
    cfg.security,
  );

const deps: RunCycleDeps = {
  gecko,
  db,
  tracker,
  telegram,
  securityScan: securityScanDep,
  cfg,
  dry,
};

async function tick(now: number): Promise<void> {
  try {
    await runCycle(deps, now);
  } catch (err) {
    // A bad cycle must never kill the process — the next tick just tries again.
    log('error', `tick failed: ${(err as Error).message}`);
  }
}

let interval: NodeJS.Timeout | undefined;

// Re-entrancy guard: a slow cycle (many sequential enrich RPC calls) can exceed `pollSeconds`,
// so setInterval would otherwise overlap ticks and the same not-yet-recorded pool could get
// posted twice. Skip a tick entirely rather than let two run concurrently.
let running = false;
async function guardedTick(now: number): Promise<void> {
  if (running) {
    log('info', 'skipping tick — previous cycle still running');
    return;
  }
  running = true;
  try {
    await tick(now);
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  log('info', `Robinhood Trending Bot starting${dry ? ' (DRY RUN — no Telegram sends)' : ''}`);
  await guardedTick(Date.now());
  interval = setInterval(() => {
    void guardedTick(Date.now());
  }, cfg.trending.pollSeconds * 1000);
}

function shutdown(signal: string): void {
  log('info', `${signal} received, shutting down`);
  if (interval) clearInterval(interval);
  db.close();
  evm.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  log('error', `fatal startup error: ${(err as Error).message}`);
  process.exit(1);
});
