/** Minimal ERC-20 `symbol()` reader — enough to label an order without asking the buyer. */

const SYMBOL_SELECTOR = '0x95d89b41';

/** Decode an eth_call result that is either a standard ABI-encoded string or a legacy
 * bytes32 symbol. Returns null when empty/undecodable. */
export function decodeAbiString(hex: string | undefined): string | null {
  if (!hex || hex === '0x') return null;
  const data = hex.slice(2);
  try {
    let bytes: string;
    if (data.length > 64) {
      const offset = parseInt(data.slice(0, 64), 16) * 2;
      const len = parseInt(data.slice(offset, offset + 64), 16) * 2;
      bytes = data.slice(offset + 64, offset + 64 + len);
    } else {
      bytes = data; // legacy bytes32 — decode up to the zero padding
    }
    let out = '';
    for (let i = 0; i < bytes.length; i += 2) {
      const c = parseInt(bytes.slice(i, i + 2), 16);
      if (!c) break;
      out += String.fromCharCode(c);
    }
    const trimmed = out.trim();
    return trimmed.length ? trimmed : null;
  } catch {
    return null;
  }
}

/** Build a symbol-lookup function bound to an RPC endpoint. Best-effort — null on any failure. */
export function erc20SymbolFetcher(rpcUrl: string, fetchFn: typeof fetch = fetch) {
  return async (address: string): Promise<string | null> => {
    try {
      const res = await fetchFn(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{ to: address, data: SYMBOL_SELECTOR }, 'latest'],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { result?: string };
      return decodeAbiString(j.result);
    } catch {
      return null;
    }
  };
}
