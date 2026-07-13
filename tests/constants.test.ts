import { describe, it, expect } from 'vitest';
import {
  CHAIN_ID,
  V2_FACTORY,
  VIRTUAL_QUOTE,
  SWAP_TOPIC,
  TRANSFER_TOPIC,
  ZERO_ADDRESS,
  DEAD_ADDRESS,
  DEAD_ADDRESSES,
  EXPLORER_BASE,
  chartUrl,
  tradeUrl,
  scanUrl,
} from '../src/chain/constants';
import { securityScan, type SecurityDeps } from '../src/checks/security';
import type { SecurityConfig } from '../src/types';

describe('chain constants (live-verified values)', () => {
  it('CHAIN_ID is the Robinhood Chain id', () => {
    expect(CHAIN_ID).toBe(4663);
  });

  it('V2_FACTORY matches the live-verified factory address', () => {
    expect(V2_FACTORY).toBe('0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f');
  });

  it('VIRTUAL_QUOTE matches the live-verified default quote token', () => {
    expect(VIRTUAL_QUOTE).toBe('0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31');
  });

  it('SWAP_TOPIC and TRANSFER_TOPIC match the standard V2 event topics', () => {
    expect(SWAP_TOPIC).toBe('0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822');
    expect(TRANSFER_TOPIC).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
  });

  it('EXPLORER_BASE matches the Blockscout base URL', () => {
    expect(EXPLORER_BASE).toBe('https://robinhoodchain.blockscout.com');
  });

  it('DEAD_ADDRESSES has exactly ZERO_ADDRESS and DEAD_ADDRESS', () => {
    expect(DEAD_ADDRESSES.size).toBe(2);
    expect(DEAD_ADDRESSES.has(ZERO_ADDRESS)).toBe(true);
    expect(DEAD_ADDRESSES.has(DEAD_ADDRESS)).toBe(true);
  });

  it('chartUrl / tradeUrl / scanUrl build the expected card button URLs', () => {
    expect(chartUrl('0xabc')).toBe('https://www.geckoterminal.com/robinhood/pools/0xabc');
    expect(tradeUrl('0xabc')).toBe('https://dexscreener.com/robinhood/0xabc');
    expect(scanUrl('0xabc')).toBe('https://robinhoodchain.blockscout.com/token/0xabc');
  });
});

// --- regression: security.ts wires DEAD_ADDRESSES from this module, not a local copy -----

describe('security.ts still exports its public API and uses this module\'s DEAD_ADDRESSES', () => {
  const CFG: SecurityConfig = { sellTaxDangerPct: 30, sellTaxWarnPct: 10, topHolderWarnPct: 25 };
  const TOKEN = '0x' + '1'.repeat(39) + 'a';
  const POOL = '0x' + '2'.repeat(39) + 'b';

  it('exports scoreSecurity and securityScan', async () => {
    const mod = await import('../src/checks/security');
    expect(typeof mod.scoreSecurity).toBe('function');
    expect(typeof mod.securityScan).toBe('function');
  });

  it('treats ZERO_ADDRESS (from constants.ts) as a renounced owner, proving the import wired through', async () => {
    const { padAddress } = await import('../src/chain/abi');
    const { SELECTORS } = await import('../src/chain/abi');
    const deps: SecurityDeps = {
      call: async (to: string, data: string) => {
        const sel = data.slice(0, 10);
        if (to === TOKEN && sel === SELECTORS.owner) return padAddress(ZERO_ADDRESS);
        throw new Error(`unstubbed call: ${to} ${sel}`);
      },
      isVerified: async () => 'unknown',
      recentHolders: async () => [],
    };
    const result = await securityScan(deps, TOKEN, POOL, CFG);
    expect(result.ownerRenounced).toBe(true);
  });
});
