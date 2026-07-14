import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { deriveDeposit } from './wallet';

interface WalletRecord {
  index: number;
  address: string;
  /** The deposit wallet's private key. SENSITIVE — `wallets.json` holds live keys, so keep the
   * file off version control (it lives under gitignored `data/`) and back it up securely. */
  privateKey: string;
}

interface WalletFile {
  nextIndex: number;
  orders: Record<string, WalletRecord>;
}

/**
 * Durable ledger of per-order deposit wallets, mirrored to `wallets.json`. Each record holds the
 * derivation index, public address, AND private key, so a deposit wallet is fully self-contained
 * (importable/sweepable without the seed). This makes the file SENSITIVE — it is written under
 * gitignored `data/`. Index allocation is monotonic (`nextIndex`) so an address is never reused.
 */
export class WalletStore {
  private data: WalletFile;

  constructor(private path: string, private mnemonic: string) {
    this.data = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as WalletFile)
      : { nextIndex: 0, orders: {} };
  }

  /** Allocate (or return the existing) deposit wallet for an order. Idempotent per order id. */
  allocate(orderId: number): WalletRecord {
    const existing = this.data.orders[String(orderId)];
    if (existing) return existing;
    const index = this.data.nextIndex;
    const { address, privateKey } = deriveDeposit(this.mnemonic, index);
    const rec: WalletRecord = { index, address, privateKey };
    this.data.orders[String(orderId)] = rec;
    this.data.nextIndex = index + 1;
    this.flush();
    return rec;
  }

  get(orderId: number): WalletRecord | null {
    return this.data.orders[String(orderId)] ?? null;
  }

  /** The deposit wallet's private key (for sweeping). Uses the stored key, falling back to
   * re-deriving from the seed for legacy records that predate key storage. Null if unallocated. */
  privateKeyFor(orderId: number): string | null {
    const rec = this.get(orderId);
    if (!rec) return null;
    return rec.privateKey ?? deriveDeposit(this.mnemonic, rec.index).privateKey;
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path); // atomic replace so a crash mid-write can't corrupt the ledger
  }
}
