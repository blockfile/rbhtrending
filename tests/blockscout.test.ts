import { describe, it, expect, vi } from 'vitest';
import { isVerified } from '../src/checks/blockscout';

describe('isVerified', () => {
  it('returns true for 200 response (verified contract)', async () => {
    const mockFetch = async (url: string, opts?: RequestInit) => {
      expect(url).toContain('/api/v2/smart-contracts/0x123abc');
      expect(opts?.headers).toEqual({ accept: 'application/json' });
      return new Response(JSON.stringify({ address: '0x123abc' }), { status: 200 });
    };

    const result = await isVerified('0x123abc', 'https://example.blockscout.com', mockFetch as any);
    expect(result).toBe(true);
  });

  it('returns false for 404 response (not verified)', async () => {
    const mockFetch = async (url: string, opts?: RequestInit) => {
      return new Response(JSON.stringify({ message: 'Not found' }), { status: 404 });
    };

    const result = await isVerified('0x456def', 'https://example.blockscout.com', mockFetch as any);
    expect(result).toBe(false);
  });

  it('returns "unknown" for 500 response', async () => {
    const mockFetch = async (url: string, opts?: RequestInit) => {
      return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 });
    };

    const result = await isVerified('0x789ghi', 'https://example.blockscout.com', mockFetch as any);
    expect(result).toBe('unknown');
  });

  it('returns "unknown" when fetchFn throws an error', async () => {
    const mockFetch = async (url: string, opts?: RequestInit) => {
      throw new Error('Network error');
    };

    const result = await isVerified('0xabc123', 'https://example.blockscout.com', mockFetch as any);
    expect(result).toBe('unknown');
  });

  it('returns "unknown" on timeout (AbortSignal timeout)', async () => {
    const mockFetch = async (url: string, opts?: RequestInit) => {
      throw new DOMException('The operation was aborted', 'AbortError');
    };

    const result = await isVerified('0xdef456', 'https://example.blockscout.com', mockFetch as any);
    expect(result).toBe('unknown');
  });

  it('constructs correct URL from baseUrl and address', async () => {
    let capturedUrl = '';
    const mockFetch = async (url: string, opts?: RequestInit) => {
      capturedUrl = url;
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await isVerified('0x999aaa', 'https://custom.blockscout.io', mockFetch as any);
    expect(capturedUrl).toBe('https://custom.blockscout.io/api/v2/smart-contracts/0x999aaa');
  });

  it('uses global fetch when fetchFn is not provided', async () => {
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn(async (_url: string, _opts?: RequestInit) =>
      new Response(JSON.stringify({ address: '0xabc' }), { status: 200 }),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    try {
      const result = await isVerified('0xabc', 'https://example.blockscout.com');
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.blockscout.com/api/v2/smart-contracts/0xabc',
        expect.objectContaining({ headers: { accept: 'application/json' } }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('never throws, even when everything fails', async () => {
    const mockFetch = async (url: string, opts?: RequestInit) => {
      throw new Error('Critical failure');
    };

    // This should not throw
    const result = await isVerified('0x111111', 'https://example.com', mockFetch as any);
    expect(result).toBe('unknown');
    expect(typeof result).toBe('string');
  });
});
