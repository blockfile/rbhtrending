// Minimal hand-rolled ABI encode/decode helpers for the handful of EVM calls
// this bot needs. No web3/ethers dependency — selectors below are precomputed
// keccak256(signature).slice(0, 4) values for well-known ERC-20 / Uniswap V2
// function signatures, so no runtime keccak256 is needed here.
export const SELECTORS = {
  owner: '0x8da5cb5b',
  balanceOf: '0x70a08231',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  getReserves: '0x0902f1ac',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd',
  getAmountsOut: '0xd06ca61f',
  factory: '0xc45a0155',
} as const;

/** Left-pads a 20-byte address into a 32-byte ABI word: '0x' + 24 zero-nibbles + 40 lowercase hex chars. */
export function padAddress(addr: string): string {
  const hex = addr.toLowerCase().replace(/^0x/, '');
  if (hex.length !== 40) {
    throw new Error(`padAddress: expected a 20-byte address (40 hex chars), got ${hex.length} chars: ${addr}`);
  }
  return '0x' + '0'.repeat(24) + hex;
}

/** Encodes a 32-byte unsigned int word: 64 zero-padded lowercase hex chars, no '0x' prefix. */
export function encodeUint(v: bigint): string {
  if (v < 0n) {
    throw new Error(`encodeUint: negative values are not supported: ${v}`);
  }
  return v.toString(16).padStart(64, '0');
}

/** Concatenates a call selector with already hex-padded 32-byte words to build calldata. */
export function encodeCall(selector: string, ...words: string[]): string {
  const sel = selector.startsWith('0x') ? selector : `0x${selector}`;
  const body = words.map((w) => w.replace(/^0x/, '')).join('');
  return sel + body;
}

/** Decodes a 32-byte ABI word to a 0x-prefixed address (last 20 bytes / 40 hex chars). */
export function decodeAddress(hex: string): string {
  const clean = hex.replace(/^0x/, '');
  return '0x' + clean.slice(-40);
}

/** Decodes a 32-byte ABI word to a bigint. Accepts with/without '0x' prefix; empty input is 0n. */
export function decodeUint(hex: string): bigint {
  const clean = hex.replace(/^0x/, '');
  if (!clean) return 0n;
  return BigInt('0x' + clean);
}
