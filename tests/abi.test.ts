import { describe, it, expect } from 'vitest';
import { SELECTORS, padAddress, encodeCall, decodeAddress, decodeUint, encodeUint } from '../src/chain/abi';

describe('SELECTORS', () => {
  it('has the precomputed 4-byte selectors for every call used later', () => {
    expect(SELECTORS.owner).toBe('0x8da5cb5b');
    expect(SELECTORS.balanceOf).toBe('0x70a08231');
    expect(SELECTORS.token0).toBe('0x0dfe1681');
    expect(SELECTORS.token1).toBe('0xd21220a7');
    expect(SELECTORS.getReserves).toBe('0x0902f1ac');
    expect(SELECTORS.symbol).toBe('0x95d89b41');
    expect(SELECTORS.decimals).toBe('0x313ce567');
    expect(SELECTORS.totalSupply).toBe('0x18160ddd');
    expect(SELECTORS.getAmountsOut).toBe('0xd06ca61f');
    expect(SELECTORS.factory).toBe('0xc45a0155');
    expect(SELECTORS.swapExactTokensForTokens).toBe('0x38ed1739');
    expect(SELECTORS.transfer).toBe('0xa9059cbb');
  });
});

describe('padAddress', () => {
  it('pads a 0x-prefixed address to a 32-byte word', () => {
    const addr = '0x1234567890123456789012345678901234567890';
    expect(padAddress(addr)).toBe('0x' + '0'.repeat(24) + '1234567890123456789012345678901234567890');
  });

  it('pads an address without a 0x prefix', () => {
    const addr = '1234567890123456789012345678901234567890';
    expect(padAddress(addr)).toBe('0x' + '0'.repeat(24) + '1234567890123456789012345678901234567890');
  });

  it('lowercases mixed-case addresses', () => {
    const addr = '0xABCDEF0123456789ABCDEF0123456789ABCDEF01';
    expect(padAddress(addr)).toBe('0x' + '0'.repeat(24) + 'abcdef0123456789abcdef0123456789abcdef01');
  });

  it('round-trips through decodeAddress', () => {
    const addr = '0x1234567890123456789012345678901234567890';
    const word = padAddress(addr);
    expect(decodeAddress(word)).toBe(addr.toLowerCase());
  });

  it('throws on an address of the wrong length', () => {
    expect(() => padAddress('0x1234')).toThrow();
  });
});

describe('decodeAddress', () => {
  it('decodes a padded 32-byte word to a 0x address', () => {
    const word = '0x' + '0'.repeat(24) + 'abcdef0123456789abcdef0123456789abcdef01';
    expect(decodeAddress(word)).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
  });

  it('works without a 0x prefix on the input word', () => {
    const word = '0'.repeat(24) + 'abcdef0123456789abcdef0123456789abcdef01';
    expect(decodeAddress(word)).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
  });
});

describe('decodeUint', () => {
  it('decodes a known 32-byte hex word to the expected bigint', () => {
    const word = '0x' + '0'.repeat(63) + 'a';
    expect(decodeUint(word)).toBe(10n);
  });

  it('handles input without a 0x prefix', () => {
    const word = '0'.repeat(63) + 'a';
    expect(decodeUint(word)).toBe(10n);
  });

  it('returns 0n for empty input', () => {
    expect(decodeUint('')).toBe(0n);
    expect(decodeUint('0x')).toBe(0n);
  });

  it('decodes a large value correctly', () => {
    const word = '0x' + 'ff'.padStart(64, '0');
    expect(decodeUint(word)).toBe(255n);
  });
});

describe('encodeUint', () => {
  it('encodes 255n as a 64-hex-char word ending in ff', () => {
    const encoded = encodeUint(255n);
    expect(encoded).toHaveLength(64);
    expect(encoded.endsWith('ff')).toBe(true);
    expect(encoded).toBe('0'.repeat(62) + 'ff');
  });

  it('encodes 0n as all zeros', () => {
    expect(encodeUint(0n)).toBe('0'.repeat(64));
  });

  it('round-trips through decodeUint', () => {
    const v = 123456789n;
    expect(decodeUint('0x' + encodeUint(v))).toBe(v);
  });

  it('throws on negative values', () => {
    expect(() => encodeUint(-1n)).toThrow();
  });
});

describe('encodeCall', () => {
  it('concatenates the selector with hex-padded words', () => {
    const addrWord = padAddress('0x1234567890123456789012345678901234567890');
    const call = encodeCall(SELECTORS.balanceOf, addrWord);
    expect(call).toBe(SELECTORS.balanceOf + '0'.repeat(24) + '1234567890123456789012345678901234567890');
  });

  it('returns just the selector when no words are given', () => {
    expect(encodeCall(SELECTORS.owner)).toBe(SELECTORS.owner);
  });

  it('concatenates multiple words in order', () => {
    const w1 = encodeUint(1n);
    const w2 = encodeUint(2n);
    const call = encodeCall(SELECTORS.getAmountsOut, w1, w2);
    expect(call).toBe(SELECTORS.getAmountsOut + w1 + w2);
  });
});
