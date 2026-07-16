import { loadConfig, loadSecrets } from './config';
import type { AppConfig } from './types';
import { Db } from './db/index';
import { GmgnClient } from './sources/gmgn';
import { Telegram } from './telegram';
import { Tracker } from './pipeline/trending';
import { log } from './logger';
import { runCycle, type RunCycleDeps } from './pipeline/runCycle';
import { PromoService } from './promo/service';
import { PaymentWatcher } from './promo/payments';
import { OrderBot } from './promo/orderBot';
import { erc20SymbolFetcher } from './promo/erc20';
import { WalletStore } from './promo/walletStore';
import { Sweeper } from './promo/sweep';
import { isValidMnemonic } from './promo/wallet';
import { rankOrganic } from './promo/leaderboard';

const dry = process.argv.includes('--dry');

const cfg = loadConfig();
const secrets = loadSecrets();

// `dbPath` isn't a validated config.json field (task-10-brief.md: "don't add it to the
// validator") — read it loosely and fall back to the default data location.
const dbPath = (cfg as AppConfig & { dbPath?: string }).dbPath ?? 'data/robinhood.db';

const db = new Db(dbPath);
const gmgn = new GmgnClient(secrets.gmgnApiKey);
const telegram = new Telegram(secrets.telegramBotToken, secrets.telegramChatId);
const tracker = new Tracker(cfg.trending, cfg.followUp);

// v1 discovery + enrichment is a single GMGN `market/rank` poll per cycle (Task G3) — every
// field a card needs (price/mc/liq/vol, holders, security flags, socials, logo) comes back in
// that one call, so there's no on-chain RPC/Blockscout wiring here anymore. Live-caption
// editing of the originally posted card is deferred to v1.1 — v1 delivers the original
// trending card plus separate follow-up posts only.
const deps: RunCycleDeps = {
  gmgn,
  db,
  tracker,
  telegram,
  cfg,
  dry,
};

// Paid ⭐ trending slots: the DM order bot + payment watcher + sweeper + pinned leaderboard only
// run live — a dry run must never take orders or touch the channel. Each order gets its own
// deposit wallet derived from PROMO_MNEMONIC; funds are swept into promo.treasuryAddress. Both
// RH_RPC_URL (payment detection + sweeping) and a valid PROMO_MNEMONIC are required.
let promo: PromoService | null = null;
let orderBot: OrderBot | null = null;
if (cfg.promo.enabled && !dry) {
  if (!secrets.rhRpcUrl) {
    log('warn', 'promo: enabled but RH_RPC_URL is missing — paid slots disabled (no payment detection)');
  } else if (!isValidMnemonic(secrets.promoMnemonic)) {
    log('warn', 'promo: enabled but PROMO_MNEMONIC is missing/invalid — paid slots disabled (cannot derive deposit wallets)');
  } else {
    const wallets = new WalletStore('data/wallets.json', secrets.promoMnemonic);
    const watcher = new PaymentWatcher(secrets.rhRpcUrl, cfg.promo, db);
    const sweeper = new Sweeper(secrets.rhRpcUrl, cfg.promo, db, wallets);
    promo = new PromoService(telegram, db, cfg.promo, watcher, sweeper);
    orderBot = new OrderBot(telegram, db, cfg.promo, wallets, erc20SymbolFetcher(secrets.rhRpcUrl));
    void orderBot.run();
    log('info', `promo: paid trending slots enabled — deposits sweep to ${cfg.promo.treasuryAddress}`);
  }
} else if (cfg.promo.enabled && dry) {
  log('info', 'promo: skipped in dry run');
}

async function tick(now: number): Promise<void> {
  try {
    const tokens = await runCycle(deps, now);
    // Leaderboard gets the filtered + score-sorted pool (rankOrganic) so rugs can't take top
    // slots; promoted cards get the raw feed so a paid token shows live stats even off-rank.
    if (promo) await promo.tick(rankOrganic(tokens, cfg.trending, now), tokens, now);
  } catch (err) {
    // A bad cycle must never kill the process — the next tick just tries again.
    log('error', `tick failed: ${(err as Error).message}`);
  }
}

let interval: NodeJS.Timeout | undefined;

// Re-entrancy guard: a slow cycle (a slow GMGN response, Telegram retries/backoff) can exceed
// `pollSeconds`, so setInterval would otherwise overlap ticks and the same not-yet-recorded
// token could get posted twice. Skip a tick entirely rather than let two run concurrently.
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
  orderBot?.stop();
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  log('error', `fatal startup error: ${(err as Error).message}`);
  process.exit(1);
});
