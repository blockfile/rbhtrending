import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
    expect(typeof cfg.trending.minLiquidityUsd).toBe('number');
  });

  it('loads security and followUp sections', () => {
    const cfg = loadConfig();
    expect(cfg.security.sellTaxDangerPct).toBe(30);
    expect(cfg.security.sellTaxWarnPct).toBe(10);
    expect(cfg.security.topHolderWarnPct).toBe(25);
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
          milestones: [2, 5, 10, 25, 50, 100],
        },
        security: {
          sellTaxDangerPct: 30,
          sellTaxWarnPct: 10,
          topHolderWarnPct: 25,
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
          milestones: [],
        },
        security: {
          sellTaxDangerPct: 30,
          sellTaxWarnPct: 10,
          topHolderWarnPct: 25,
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
          milestones: [2, 5, 'ten', 25, 50, 100],
        },
        security: {
          sellTaxDangerPct: 30,
          sellTaxWarnPct: 10,
          topHolderWarnPct: 25,
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
          milestones: [2, 5, 10, 25, 50, 100],
        },
        security: {
          sellTaxDangerPct: 30,
          sellTaxWarnPct: 10,
          topHolderWarnPct: 25,
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
    });
    expect(s.rhRpcUrl).toBe('https://rpc.example.com');
    expect(s.rhWsUrl).toBe('wss://ws.example.com');
    expect(s.telegramBotToken).toBe('token123');
    expect(s.telegramChatId).toBe('-100123456789');
    expect(s.geckoTerminalApiKey).toBe(''); // optional — empty when unset
  });

  it('passes through the optional GeckoTerminal API key', () => {
    const s = loadSecrets({
      RH_RPC_URL: 'https://rpc.example.com',
      RH_WS_URL: 'wss://ws.example.com',
      TELEGRAM_BOT_TOKEN: 'token123',
      TELEGRAM_CHAT_ID: '-100123456789',
      GECKOTERMINAL_API_KEY: 'gt-key-123',
    });
    expect(s.geckoTerminalApiKey).toBe('gt-key-123');
  });

  it('throws naming every missing required var', () => {
    expect(() => loadSecrets({})).toThrow(/RH_RPC_URL.*RH_WS_URL.*TELEGRAM_BOT_TOKEN.*TELEGRAM_CHAT_ID/s);
  });

  it('throws on missing RH_RPC_URL', () => {
    expect(() => loadSecrets({
      RH_WS_URL: 'wss://ws.example.com',
      TELEGRAM_BOT_TOKEN: 'token123',
      TELEGRAM_CHAT_ID: '-100123456789',
    })).toThrow(/RH_RPC_URL/);
  });

  it('throws on missing RH_WS_URL', () => {
    expect(() => loadSecrets({
      RH_RPC_URL: 'https://rpc.example.com',
      TELEGRAM_BOT_TOKEN: 'token123',
      TELEGRAM_CHAT_ID: '-100123456789',
    })).toThrow(/RH_WS_URL/);
  });
});
