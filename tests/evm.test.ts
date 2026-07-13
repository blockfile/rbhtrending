import { describe, it, expect, afterEach, vi } from 'vitest';
import { Evm } from '../src/chain/evm';

describe('Evm.blockNumber', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses the hex eth_blockNumber result into a decimal number', async () => {
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe('eth_blockNumber');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0xa' }), { status: 200 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const evm = new Evm('https://rpc.example', 'wss://ws.example');
    const n = await evm.blockNumber();

    expect(n).toBe(10);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
