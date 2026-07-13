import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { decodeAddress } from './abi';

interface JsonRpcErrorPayload {
  code: number;
  message: string;
}

interface PairSubscription {
  factoryAddr: string;
  topic0: string;
}

/**
 * Thin EVM client for Robinhood Chain (chain 4663): JSON-RPC over HTTP (fetch)
 * plus a WS log subscription with reconnect/backoff/watchdog, mirroring the
 * pattern in Trenches' pumpportal.ts. The PairCreated decode is wired up but
 * stays inert until a caller opts in via subscribePairs(factoryAddr, topic0) —
 * the factory address and topic0 aren't finalized yet (see Task 5/6).
 */
export class Evm extends EventEmitter {
  private ws: WebSocket | null = null;
  private backoffMs = 1000;
  private closed = false;
  private lastMessageAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private reqId = 1;
  private pairSub: PairSubscription | null = null;
  private subId: string | null = null;

  constructor(private rpcUrl: string, private wsUrl: string) {
    super();
  }

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = 1000;
      this.lastMessageAt = Date.now();
      this.emit('status', 'connected');
      this.resubscribePairs();
    });

    ws.on('message', (data) => {
      this.lastMessageAt = Date.now();
      this.handleMessage(data.toString());
    });

    // 'error' always precedes 'close'; schedule the reconnect only from 'close' so it fires once
    ws.on('error', (err) => this.emit('status', `ws error: ${err.message}`));
    ws.on('close', () => {
      if (this.closed) return;
      this.subId = null;
      this.emit('status', `reconnecting in ${this.backoffMs}ms`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });

    this.ensureWatchdog();
  }

  private ensureWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      if (this.closed || !this.ws) return;
      if (this.lastMessageAt && Date.now() - this.lastMessageAt > 120_000) {
        this.emit('status', 'no messages for 120s — terminating stale socket');
        this.ws.terminate();
      }
    }, 60_000);
    this.watchdog.unref();
  }

  /**
   * Opts in to the PairCreated log subscription. No-op (beyond storing the
   * filter) until the socket is open, at which point 'logs' eth_subscribe is
   * sent; re-sent automatically on every reconnect.
   */
  subscribePairs(factoryAddr: string, topic0: string): void {
    this.pairSub = { factoryAddr, topic0 };
    if (this.ws?.readyState === WebSocket.OPEN) this.resubscribePairs();
  }

  private resubscribePairs(): void {
    if (!this.pairSub) return;
    this.sendIfOpen({
      jsonrpc: '2.0',
      id: this.reqId++,
      method: 'eth_subscribe',
      params: ['logs', { address: this.pairSub.factoryAddr, topics: [this.pairSub.topic0] }],
    });
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // eth_subscribe RPC response: { id, result: '<subscriptionId>' }
    if (msg.id !== undefined && typeof msg.result === 'string') {
      this.subId = msg.result;
      return;
    }

    // eth_subscription push: { method: 'eth_subscription', params: { subscription, result: <log> } }
    if (msg.method === 'eth_subscription' && msg.params?.subscription === this.subId) {
      this.handlePairLog(msg.params.result);
    }
  }

  // Uniswap V2 factory event: PairCreated(address indexed token0, address indexed token1, address pair, uint256)
  // token0/token1 are indexed -> topics[1]/topics[2]; pair is the first word of non-indexed data.
  private handlePairLog(log: any): void {
    if (!this.pairSub || !log) return;
    try {
      const topics = log.topics as string[];
      const token0 = decodeAddress(topics[1]);
      const token1 = decodeAddress(topics[2]);
      const data = ((log.data as string) ?? '0x').replace(/^0x/, '');
      const pair = decodeAddress('0x' + data.slice(0, 64));
      this.emit('pair', { token0, token1, pair, log });
    } catch (err) {
      this.emit('status', `pair decode error: ${(err as Error).message}`);
    }
  }

  private sendIfOpen(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  async call(to: string, data: string, from?: string): Promise<string> {
    const params: Record<string, string> = { to, data, ...(from ? { from } : {}) };
    const result = await this.rpcCall('eth_call', [params, 'latest']);
    return result as string;
  }

  async getLogs(filter: object): Promise<any[]> {
    const result = await this.rpcCall('eth_getLogs', [filter]);
    return (result as any[]) ?? [];
  }

  private async rpcCall(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.reqId++, method, params }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`RPC HTTP error: ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    if (json.error) {
      const err = json.error as JsonRpcErrorPayload;
      throw new Error(`RPC error ${err.code}: ${err.message}`);
    }

    return json.result;
  }

  close(): void {
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.close();
  }
}
