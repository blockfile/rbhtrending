import { JsonRpcProvider, Wallet } from 'ethers';
import type { Db } from '../db/index';
import type { PromoConfig } from '../types';
import type { WalletStore } from './walletStore';
import { log } from './../logger';

/** Plain native-ETH transfer gas, plus a safety multiplier so fee spikes / L2 data fees don't
 * make the sweep tx underpriced. Leftover dust stays in the deposit address and is swept next
 * pass. */
const TRANSFER_GAS = 21_000n;
const GAS_BUFFER = 3;

/**
 * Amount to forward when sweeping a deposit address: full balance minus a buffered gas reserve
 * (gas for the sweep tx is paid out of the same balance). Returns null when the balance can't
 * cover gas — i.e. dust not worth moving.
 */
export function computeSweepValue(balance: bigint, gasLimit: bigint, gasPriceWei: bigint, bufferX: number): bigint | null {
  const reserve = gasLimit * gasPriceWei * BigInt(bufferX);
  const value = balance - reserve;
  return value > 0n ? value : null;
}

/**
 * Forwards paid orders' deposits into the treasury (main) wallet. Each unswept paid order's
 * deposit key is re-derived from the seed, its balance read, and (balance − gas) sent to
 * `treasuryAddress`. Best-effort and idempotent: a failed sweep leaves the funds in the deposit
 * address and `sweep_tx` NULL, so the next tick retries — nothing is ever stranded or double-sent
 * (double-send is naturally bounded since a successful sweep empties the address).
 */
export class Sweeper {
  private provider: JsonRpcProvider;

  constructor(
    rpcUrl: string,
    private cfg: PromoConfig,
    private db: Db,
    private wallets: WalletStore,
  ) {
    this.provider = new JsonRpcProvider(rpcUrl);
  }

  async tick(): Promise<void> {
    for (const o of this.db.unsweptPaidOrders()) {
      try {
        await this.sweepOne(o.id);
      } catch (err) {
        log('warn', `promo: sweep of order #${o.id} failed (will retry): ${(err as Error).message}`);
      }
    }
  }

  private async sweepOne(orderId: number): Promise<void> {
    const pk = this.wallets.privateKeyFor(orderId);
    if (!pk) {
      log('warn', `promo: no deposit key for order #${orderId} — cannot sweep`);
      return;
    }
    const signer = new Wallet(pk, this.provider);
    const balance = await this.provider.getBalance(signer.address);
    if (balance === 0n) return; // already swept or not yet funded

    const fee = await this.provider.getFeeData();
    const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 1_000_000_000n;
    const value = computeSweepValue(balance, TRANSFER_GAS, gasPrice, GAS_BUFFER);
    if (value === null) {
      log('info', `promo: order #${orderId} deposit balance is dust — skipping sweep`);
      return;
    }

    const tx = await signer.sendTransaction({ to: this.cfg.treasuryAddress, value, gasLimit: TRANSFER_GAS });
    this.db.markSwept(orderId, tx.hash);
    log('info', `promo: swept order #${orderId} deposit → treasury (${tx.hash})`);
  }
}
