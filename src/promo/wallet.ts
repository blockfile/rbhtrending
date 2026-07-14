import { HDNodeWallet, Mnemonic } from 'ethers';

/** BIP44 Ethereum account path — one fresh deposit address per order at the leaf index. */
const path = (index: number): string => `m/44'/60'/0'/0/${index}`;

/**
 * Deterministically derive an order's deposit wallet from the promo HD seed. Only the address
 * is persisted (to wallets.json / the DB); the private key is re-derived on demand at sweep
 * time and never stored, so a leaked wallets.json exposes no funds. Address is lowercased for
 * consistent comparison across the codebase.
 */
export function deriveDeposit(mnemonic: string, index: number): { address: string; privateKey: string } {
  const w = HDNodeWallet.fromPhrase(mnemonic, undefined, path(index));
  return { address: w.address.toLowerCase(), privateKey: w.privateKey };
}

/** True if `phrase` is a valid BIP39 mnemonic (checksum included). */
export function isValidMnemonic(phrase: string): boolean {
  try {
    return Mnemonic.isValidMnemonic(phrase.trim());
  } catch {
    return false;
  }
}
