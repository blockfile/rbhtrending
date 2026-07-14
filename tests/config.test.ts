import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, loadSecrets } from '../src/config';

describe('loadConfig', () => {
  it('loads the repo config.json with required numeric thresholds', () => {
    const cfg = loadConfig();
    expect(cfg.trending.minLiquidityUsd).toBe(5000);
    expect(cfg.trending.minVolume1hUsd).toBe(10000);
    expect(cfg.trending.minBuyers1h).toBe(30);
    expect(cfg.trending.pollSeconds).toBe(45);
    expect(cfg.trending.dumpDrawdownPct).toBe(50);
    expect(cfg.trending.maxPostsPerCycle).toBe(10);
    expect(cfg.trending.minMcOfAthPct).toBe(20);
    expect(cfg.trending.minMcOfAthAgeHours).toBe(24);
    expect(typeof cfg.trending.minLiquidityUsd).toBe('number');
  });

  it('loads followUp section', () => {
    const cfg = loadConfig();
    expect(cfg.followUp.windowMinutes).toBe(120);
    expect(cfg.followUp.liveEditSec).toBe(45);
  });

  it('loads buttons configuration', () => {
    const cfg = loadConfig();
    expect(typeof cfg.buttons.chart).toBe('boolean');
    expect(typeof cfg.buttons.scan).toBe('boolean');
    expect(typeof cfg.buttons.trade).toBe('boolean');
    expect(cfg.buttons.chart).toBe(true);
    expect(cfg.buttons.scan).toBe(true);
    expect(cfg.buttons.trade).toBe(true);
  });

  it('loads trending milestones array', () => {
    const cfg = loadConfig();
    expect(Array.isArray(cfg.trending.milestones)).toBe(true);
    expect(cfg.trending.milestones.length).toBeGreaterThan(0);
    expect(cfg.trending.milestones.every((m) => typeof m === 'number')).toBe(true);
    expect(cfg.trending.milestones).toEqual([2, 5, 10, 25, 50, 100]);
  });

  it('throws ENOENT when config file does not exist', () => {
    expect(() => loadConfig('nonexistent.json')).toThrow(/ENOENT/);
  });

  it('loads the promo section with tiers, prices, and payment settings', () => {
    const cfg = loadConfig();
    expect(typeof cfg.promo.enabled).toBe('boolean');
    expect(typeof cfg.promo.treasuryAddress).toBe('string');
    expect(cfg.promo.confirmations).toBeGreaterThan(0);
    expect(cfg.promo.leaderboardSize).toBe(12);
    expect(cfg.promo.pendingMinutes).toBeGreaterThan(0);
    expect(Array.isArray(cfg.promo.adminChatIds)).toBe(true);
    expect(cfg.promo.tiers.top3.maxRank).toBe(3);
    expect(cfg.promo.tiers.top8.maxRank).toBe(8);
    expect(cfg.promo.tiers.top12.maxRank).toBe(12);
    expect(cfg.promo.tiers.top3.prices['3']).toBeGreaterThan(0);
    expect(cfg.promo.tiers.top3.prices['24']).toBeGreaterThan(0);
  });

  it('throws when promo is enabled without a valid 0x payment address', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'rbh-'));
    try {
      const cfgPath = join(tmpDir, 'config.json');
      const base = JSON.parse(readFileSync('config.json', 'utf8'));
      base.promo.enabled = true;
      base.promo.treasuryAddress = '';
      writeFileSync(cfgPath, JSON.stringify(base));
      expect(() => loadConfig(cfgPath)).toThrow('config.json promo.enabled requires a valid promo.treasuryAddress (0x…)');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('accepts promo enabled with a valid payment address', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'rbh-'));
    try {
      const cfgPath = join(tmpDir, 'config.json');
      const base = JSON.parse(readFileSync('config.json', 'utf8'));
      base.promo.enabled = true;
      base.promo.treasuryAddress = '0xCA00000000000000000000000000000000CAFE00';
      writeFileSync(cfgPath, JSON.stringify(base));
      expect(() => loadConfig(cfgPath)).not.toThrow();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws specific error when numeric field is missing (trending.minLiquidityUsd)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'rbh-'));
    try {
      const cfgPath = join(tmpDir, 'config.json');
      const malformed = {
        trending: {
          minVolume1hUsd: 10000,
          minBuyers1h: 30,
          pollSeconds: 45,
          dumpDrawdownPct: 50,
          maxPostsPerCycle: 10,
          milestones: [2, 5, 10, 25, 50, 100],
        },
        followUp: {
          windowMinutes: 120,
          liveEditSec: 45,
        },
        buttons: {
          chart: true,
          scan: true,
          trade: true,
        },
      };
      writeFileSync(cfgPath, JSON.stringify(malformed));
      expect(() => loadConfig(cfgPath)).toThrow('config.json missing numeric field: trending.minLiquidityUsd');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws specific error when numeric field is missing (trending.maxPostsPerCycle)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'rbh-'));
    try {
      const cfgPath = join(tmpDir, 'config.json');
      const malformed = {
        trending: {
          minLiquidityUsd: 5000,
          minVolume1hUsd: 10000,
          minBuyers1h: 30,
          pollSeconds: 45,
          dumpDrawdownPct: 50,
          milestones: [2, 5, 10, 25, 50, 100],
        },
        followUp: {
          windowMinutes: 120,
          liveEditSec: 45,
        },
        buttons: {
          chart: true,
          scan: true,
          trade: true,
        },
      };
      writeFileSync(cfgPath, JSON.stringify(malformed));
      expect(() => loadConfig(cfgPath)).toThrow('config.json missing numeric field: trending.maxPostsPerCycle');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws specific error when milestones is empty array', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'rbh-'));
    try {
      const cfgPath = join(tmpDir, 'config.json');
      const malformed = {
        trending: {
          minLiquidityUsd: 5000,
          minVolume1hUsd: 10000,
          minBuyers1h: 30,
          pollSeconds: 45,
          dumpDrawdownPct: 50,
          maxPostsPerCycle: 10,
          minMcOfAthPct: 20,
          minMcOfAthAgeHours: 24,
          milestones: [],
        },
        followUp: {
          windowMinutes: 120,
          liveEditSec: 45,
        },
        buttons: {
          chart: true,
          scan: true,
          trade: true,
        },
      };
      writeFileSync(cfgPath, JSON.stringify(malformed));
      expect(() => loadConfig(cfgPath)).toThrow('config.json missing number array: trending.milestones');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws specific error when milestones contains non-number', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'rbh-'));
    try {
      const cfgPath = join(tmpDir, 'config.json');
      const malformed = {
        trending: {
          minLiquidityUsd: 5000,
          minVolume1hUsd: 10000,
          minBuyers1h: 30,
          pollSeconds: 45,
          dumpDrawdownPct: 50,
          maxPostsPerCycle: 10,
          minMcOfAthPct: 20,
          minMcOfAthAgeHours: 24,
          milestones: [2, 5, 'ten', 25, 50, 100],
        },
        followUp: {
          windowMinutes: 120,
          liveEditSec: 45,
        },
        buttons: {
          chart: true,
          scan: true,
          trade: true,
        },
      };
      writeFileSync(cfgPath, JSON.stringify(malformed));
      expect(() => loadConfig(cfgPath)).toThrow('config.json missing number array: trending.milestones');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws specific error when buttons.chart is not boolean', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'rbh-'));
    try {
      const cfgPath = join(tmpDir, 'config.json');
      const malformed = {
        trending: {
          minLiquidityUsd: 5000,
          minVolume1hUsd: 10000,
          minBuyers1h: 30,
          pollSeconds: 45,
          dumpDrawdownPct: 50,
          maxPostsPerCycle: 10,
          minMcOfAthPct: 20,
          minMcOfAthAgeHours: 24,
          milestones: [2, 5, 10, 25, 50, 100],
        },
        followUp: {
          windowMinutes: 120,
          liveEditSec: 45,
        },
        buttons: {
          chart: 'yes',
          scan: true,
          trade: true,
        },
      };
      writeFileSync(cfgPath, JSON.stringify(malformed));
      expect(() => loadConfig(cfgPath)).toThrow('config.json missing buttons config (chart, scan, trade as booleans)');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('loadSecrets', () => {
  it('returns secrets when all required env vars present', () => {
    const s = loadSecrets({
      RH_RPC_URL: 'https://rpc.example.com',
      RH_WS_URL: 'wss://ws.example.com',
      TELEGRAM_BOT_TOKEN: 'token123',
      TELEGRAM_CHAT_ID: '-100123456789',
      GMGN_API_KEY: 'gmgn-key-123',
    });
    expect(s.rhRpcUrl).toBe('https://rpc.example.com');
    expect(s.rhWsUrl).toBe('wss://ws.example.com');
    expect(s.telegramBotToken).toBe('token123');
    expect(s.telegramChatId).toBe('-100123456789');
    expect(s.geckoTerminalApiKey).toBe(''); // optional — empty when unset
    expect(s.gmgnApiKey).toBe('gmgn-key-123');
  });

  it('passes through the optional GeckoTerminal API key', () => {
    const s = loadSecrets({
      RH_RPC_URL: 'https://rpc.example.com',
      RH_WS_URL: 'wss://ws.example.com',
      TELEGRAM_BOT_TOKEN: 'token123',
      TELEGRAM_CHAT_ID: '-100123456789',
      GECKOTERMINAL_API_KEY: 'gt-key-123',
      GMGN_API_KEY: 'gmgn-key-123',
    });
    expect(s.geckoTerminalApiKey).toBe('gt-key-123');
  });

  it('throws naming every missing required var', () => {
    expect(() => loadSecrets({})).toThrow(/TELEGRAM_BOT_TOKEN.*TELEGRAM_CHAT_ID.*GMGN_API_KEY/s);
  });

  it('boots without RH_RPC_URL/RH_WS_URL — no longer required now that Evm/on-chain scanning is gone', () => {
    const s = loadSecrets({
      TELEGRAM_BOT_TOKEN: 'token123',
      TELEGRAM_CHAT_ID: '-100123456789',
      GMGN_API_KEY: 'gmgn-key-123',
    });
    expect(s.rhRpcUrl).toBe('');
    expect(s.rhWsUrl).toBe('');
  });

  it('throws on missing GMGN_API_KEY', () => {
    expect(() => loadSecrets({
      RH_RPC_URL: 'https://rpc.example.com',
      RH_WS_URL: 'wss://ws.example.com',
      TELEGRAM_BOT_TOKEN: 'token123',
      TELEGRAM_CHAT_ID: '-100123456789',
    })).toThrow(/GMGN_API_KEY/);
  });
});
