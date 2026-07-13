// Robinhood Chain (EVM L2) — constants verified live 2026-07-13 via on-chain probes.
export const CHAIN_ID = 4663;

// Uniswap V2-style factory (from a live pair's factory()). NOTE: this chain has NO
// standard UniswapV2Router02 exposing getAmountsOut — pairs are V2 (getReserves/token0/
// token1/swap) but trading routes through custom routers. Compute prices from reserves,
// not via a router. (No router constant on purpose.)
export const V2_FACTORY = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f';

// Most memecoins quote against VIRTUAL, but ALWAYS read the pool's token0()/token1() to
// find the real quote — this is only the common default, never assume it.
export const VIRTUAL_QUOTE = '0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31';

// Uniswap V2 event topics (standard keccak sigs — reused for log filters).
export const SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';
// Burn/renounce sinks (lowercase). LP sent here = burned; owner here = renounced.
export const DEAD_ADDRESSES = new Set<string>([ZERO_ADDRESS, DEAD_ADDRESS]);

// Blockscout explorer — powers the isVerified() check AND the Scan button.
export const EXPLORER_BASE = 'https://robinhoodchain.blockscout.com';

// Card button URL builders (poolAddress / tokenAddress are 0x-addresses).
export const chartUrl = (pool: string) => `https://www.geckoterminal.com/robinhood/pools/${pool}`;
export const tradeUrl = (pool: string) => `https://dexscreener.com/robinhood/${pool}`;
export const scanUrl = (token: string) => `${EXPLORER_BASE}/token/${token}`;
