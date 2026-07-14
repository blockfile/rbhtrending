import type { OrderRow, Db } from '../db/index';
import type { PromoConfig } from '../types';
import { log } from '../logger';

export interface PaymentMatch {
  orderId: number;
  txHash: string;
}

interface RpcTx {
  to: string | null;
  value: bigint;
  hash: string;
}

/** Pure matcher: a native transfer to the payment wallet whose value equals a pending order's
 * quoted amount exactly is that order's payment. Each order matches at most once (first tx
 * wins); wrong amounts and other recipients are ignored. Address compare is case-insensitive. */
export function matchPayments(pending: OrderRow[], txs: RpcTx[], paymentAddress: string): PaymentMatch[] {
  const pay = paymentAddress.toLowerCase();
  const open = new Map(pending.map((o) => [o.amountWei, o]));
  const matches: PaymentMatch[] = [];
  for (const tx of txs) {
    if ((tx.to ?? '').toLowerCase() !== pay) continue;
    const order = open.get(tx.value.toString());
    if (order) {
      open.delete(tx.value.toString());
      matches.push({ orderId: order.id, txHash: tx.hash });
    }
  }
  return matches;
}

/** Hard cap on blocks fetched per tick so a long RPC outage can't turn into a giant catch-up
 * burst; anything older is skipped (with a warning) and would need manual reconciliation. */
const MAX_BLOCKS_PER_TICK = 400;

const CURSOR_KEY = 'last_scanned_block';

/**
 * Watches Robinhood Chain for order payments: each tick it scans new confirmed blocks
 * (latest − confirmations) for native transfers to the payment wallet and exact-amount-matches
 * them against pending orders. With no pending orders it just fast-forwards the cursor —
 * payment scanning only costs RPC calls while a quote is actually outstanding.
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

  /** Scan newly-confirmed blocks; returns payment matches for pending orders. Throws on RPC
   * failure — the caller catches and simply retries next tick (the cursor only advances after
   * a successful scan, so nothing is missed). */
  async tick(): Promise<PaymentMatch[]> {
    const [latestHex] = (await this.rpc([{ method: 'eth_blockNumber', params: [] }])) as [string];
    const target = parseInt(latestHex, 16) - this.cfg.confirmations;
    if (!Number.isFinite(target) || target < 1) return [];

    const pending = this.db.pendingOrders();
    if (pending.length === 0) {
      this.db.setMeta(CURSOR_KEY, String(target));
      return [];
    }

    const cursor = this.db.getMeta(CURSOR_KEY);
    let from = cursor !== null ? parseInt(cursor, 10) + 1 : target;
    if (target - from + 1 > MAX_BLOCKS_PER_TICK) {
      log('warn', `payments: scan range ${from}..${target} too large — skipping to last ${MAX_BLOCKS_PER_TICK} blocks`);
      from = target - MAX_BLOCKS_PER_TICK + 1;
    }
    if (from > target) return [];

    const nums = Array.from({ length: target - from + 1 }, (_, i) => from + i);
    const blocks = (await this.rpc(
      nums.map((n) => ({ method: 'eth_getBlockByNumber', params: ['0x' + n.toString(16), true] })),
    )) as Array<{ transactions?: Array<{ to: string | null; value: string; hash: string }> } | null>;

    const txs: RpcTx[] = blocks.flatMap((b) =>
      (b?.transactions ?? []).map((t) => ({ to: t.to, value: BigInt(t.value), hash: t.hash })),
    );

    const matches = matchPayments(pending, txs, this.cfg.paymentAddress);
    this.db.setMeta(CURSOR_KEY, String(target));
    return matches;
  }
}
