import type { OrderRow, Db } from '../db/index';
import type { PromoConfig } from '../types';
import { log } from '../logger';

export interface PaymentMatch {
  orderId: number;
  depositAddress: string;
}

/** Pure matcher: a pending order is paid once its own deposit address holds at least the quoted
 * amount (overpayment is fine, underpayment is not). One address per order, so no cross-order
 * disambiguation is needed. `balances` is keyed by lowercased address. */
export function matchByBalance(pending: OrderRow[], balances: Record<string, bigint>): PaymentMatch[] {
  const matches: PaymentMatch[] = [];
  for (const o of pending) {
    const bal = balances[o.depositAddress.toLowerCase()] ?? 0n;
    if (bal >= BigInt(o.amountWei)) {
      matches.push({ orderId: o.id, depositAddress: o.depositAddress });
    }
  }
  return matches;
}

/**
 * Watches each pending order's own deposit address for its payment. Every tick it reads the
 * confirmed-block balance (`eth_getBalance` at `latest − confirmations`) of each pending
 * deposit address in one batched JSON-RPC call and returns the funded ones. With no pending
 * orders it makes a single `eth_blockNumber` call and returns nothing — payment polling only
 * costs RPC while a quote is actually outstanding.
 */
export class PaymentWatcher {
  constructor(
    private rpcUrl: string,
    private cfg: PromoConfig,
    private db: Db,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async rpc(requests: Array<{ method: string; params: unknown[] }>): Promise<unknown[]> {
    const body = requests.map((r, i) => ({ jsonrpc: '2.0', id: i + 1, method: r.method, params: r.params }));
    const res = await this.fetchFn(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body.length === 1 ? body[0] : body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const json = (await res.json()) as { result?: unknown } | Array<{ id: number; result?: unknown }>;
    const arr = Array.isArray(json) ? [...json].sort((a, b) => a.id - b.id) : [json];
    return arr.map((r) => r.result);
  }

  /** Returns payment matches for pending orders. Throws on RPC failure — the caller catches and
   * retries next tick (nothing is persisted here, so a failed poll simply re-runs). */
  async tick(): Promise<PaymentMatch[]> {
    const [latestHex] = (await this.rpc([{ method: 'eth_blockNumber', params: [] }])) as [string];
    const confirmed = parseInt(latestHex, 16) - this.cfg.confirmations;
    if (!Number.isFinite(confirmed) || confirmed < 0) return [];

    const pending = this.db.pendingOrders();
    if (pending.length === 0) return [];

    const blockTag = '0x' + confirmed.toString(16);
    const results = (await this.rpc(
      pending.map((o) => ({ method: 'eth_getBalance', params: [o.depositAddress, blockTag] })),
    )) as string[];

    const balances: Record<string, bigint> = {};
    pending.forEach((o, i) => {
      balances[o.depositAddress.toLowerCase()] = results[i] ? BigInt(results[i]) : 0n;
    });

    return matchByBalance(pending, balances);
  }
}
