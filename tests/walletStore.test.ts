import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WalletStore } from '../src/promo/walletStore';

const MNEMONIC = 'test test test test test test test test test test test junk';

describe('WalletStore', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rbh-wallets-'));
    path = join(dir, 'wallets.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Known hardhat vectors: index 0/1 private keys for the test mnemonic.
  const PK0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

  it('allocates sequential indices with the matching public address and private key', () => {
    const s = new WalletStore(path, MNEMONIC);
    const a = s.allocate(101);
    const b = s.allocate(102);
    expect(a).toEqual({
      index: 0,
      address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      privateKey: PK0,
    });
    expect(b.index).toBe(1);
    expect(b.address).toBe('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
    expect(b.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('persists the public address AND private key per order to wallets.json', () => {
    new WalletStore(path, MNEMONIC).allocate(101);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    expect(json.nextIndex).toBe(1);
    expect(json.orders['101']).toEqual({
      index: 0,
      address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      privateKey: PK0,
    });
  });

  it('reloads nextIndex and prior allocations from an existing file', () => {
    new WalletStore(path, MNEMONIC).allocate(101);
    const reopened = new WalletStore(path, MNEMONIC);
    expect(reopened.get(101)?.address).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
    expect(reopened.allocate(102).index).toBe(1); // continues, does not reuse index 0
  });

  it('allocate is idempotent per order id', () => {
    const s = new WalletStore(path, MNEMONIC);
    const first = s.allocate(101);
    const again = s.allocate(101);
    expect(again).toEqual(first);
    expect(s.allocate(102).index).toBe(1);
  });

  it('resolves the private key for a stored order (from the file, or re-derived for legacy records)', () => {
    const s = new WalletStore(path, MNEMONIC);
    s.allocate(101);
    expect(s.privateKeyFor(101)).toBe(PK0);
    expect(s.privateKeyFor(999)).toBeNull();
  });

  it('starts empty when no file exists yet', () => {
    const s = new WalletStore(path, MNEMONIC);
    expect(existsSync(path)).toBe(false);
    expect(s.get(1)).toBeNull();
  });
});
