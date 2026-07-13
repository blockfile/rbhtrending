import { describe, it, expect } from 'vitest';
import { recentHolders } from '../src/chain/holders';
import { padAddress } from '../src/chain/abi';
import { TRANSFER_TOPIC, ZERO_ADDRESS, DEAD_ADDRESS } from '../src/chain/constants';
import type { Evm } from '../src/chain/evm';

interface FakeEvmOpts {
  blockNumber?: () => Promise<number>;
  getLogs?: (filter: any) => Promise<any[]>;
}

function fakeEvm(opts: FakeEvmOpts = {}): Evm {
  return {
    blockNumber: opts.blockNumber ?? (async () => 1_000_000),
    getLogs: opts.getLogs ?? (async () => []),
  } as unknown as Evm;
}

const SENDER = padAddress('0x' + '1'.repeat(40));

function transferLog(to: string): { topics: string[] } {
  return { topics: [TRANSFER_TOPIC, SENDER, padAddress(to)] };
}

const TOKEN = '0xTOKEN0000000000000000000000000000000000';
const H1 = '0x' + '1'.repeat(39) + 'a';
const H2 = '0x' + '2'.repeat(39) + 'b';

describe('recentHolders', () => {
  it('queries eth_getLogs for the Transfer topic, capped to <=9500 blocks under the current tip', async () => {
    let capturedFilter: any;
    const evm = fakeEvm({
      blockNumber: async () => 1_000_000,
      getLogs: async (filter) => {
        capturedFilter = filter;
        return [];
      },
    });

    await recentHolders(evm, TOKEN);

    expect(capturedFilter.address).toBe(TOKEN);
    expect(capturedFilter.topics).toEqual([TRANSFER_TOPIC]);
    expect(capturedFilter.fromBlock).toBe('0x' + (1_000_000 - 9500).toString(16));
    expect(capturedFilter.toBlock).toBe('latest');
  });

  it('clamps fromBlock to 0 when the chain tip is below the range window', async () => {
    let capturedFilter: any;
    const evm = fakeEvm({
      blockNumber: async () => 100,
      getLogs: async (filter) => {
        capturedFilter = filter;
        return [];
      },
    });

    await recentHolders(evm, TOKEN);

    expect(capturedFilter.fromBlock).toBe('0x0');
  });

  it('returns unique recipients, newest-first (eth_getLogs returns oldest-first)', async () => {
    // oldest-first order as returned by the RPC: H1, H2, H1 (repeat)
    const evm = fakeEvm({
      getLogs: async () => [transferLog(H1), transferLog(H2), transferLog(H1)],
    });

    const result = await recentHolders(evm, TOKEN);

    expect(result).toEqual([H1.toLowerCase(), H2.toLowerCase()]);
  });

  it('excludes zero/dead recipients', async () => {
    const evm = fakeEvm({
      getLogs: async () => [
        transferLog(H1),
        transferLog(ZERO_ADDRESS),
        transferLog(DEAD_ADDRESS),
        transferLog(H2),
      ],
    });

    const result = await recentHolders(evm, TOKEN);

    expect(result).toEqual([H2.toLowerCase(), H1.toLowerCase()]);
  });

  it('resolves to [] and never throws when getLogs rejects', async () => {
    const evm = fakeEvm({
      getLogs: async () => {
        throw new Error('rpc down');
      },
    });

    await expect(recentHolders(evm, TOKEN)).resolves.toEqual([]);
  });

  it('resolves to [] and never throws when blockNumber rejects', async () => {
    const evm = fakeEvm({
      blockNumber: async () => {
        throw new Error('rpc down');
      },
    });

    await expect(recentHolders(evm, TOKEN)).resolves.toEqual([]);
  });
});
