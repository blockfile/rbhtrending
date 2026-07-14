import { describe, it, expect } from 'vitest';
import { deriveDeposit, isValidMnemonic } from '../src/promo/wallet';

// Hardhat's well-known deterministic test mnemonic → publicly documented addresses.
const MNEMONIC = 'test test test test test test test test test test test junk';

describe('deriveDeposit', () => {
  it('derives BIP44 m/44\'/60\'/0\'/0/index addresses matching the known vectors (lowercased)', () => {
    expect(deriveDeposit(MNEMONIC, 0).address).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
    expect(deriveDeposit(MNEMONIC, 1).address).toBe('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
  });

  it('is deterministic — same seed + index always yields the same address and key', () => {
    const a = deriveDeposit(MNEMONIC, 5);
    const b = deriveDeposit(MNEMONIC, 5);
    expect(a).toEqual(b);
    expect(a.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('different indices give different addresses', () => {
    expect(deriveDeposit(MNEMONIC, 2).address).not.toBe(deriveDeposit(MNEMONIC, 3).address);
  });
});

describe('isValidMnemonic', () => {
  it('accepts a valid BIP39 phrase and rejects junk', () => {
    expect(isValidMnemonic(MNEMONIC)).toBe(true);
    expect(isValidMnemonic('not a real seed phrase at all nope nope')).toBe(false);
    expect(isValidMnemonic('')).toBe(false);
  });
});
