import type { Evm } from './evm';
import { decodeAddress } from './abi';
import { TRANSFER_TOPIC, DEAD_ADDRESSES } from './constants';

/** eth_getLogs on this RPC is capped at a 10 000-block range — stay comfortably under it. */
const LOG_RANGE_BLOCKS = 9500;

/**
 * Best-effort recent-holder lookup for the v1 Option-A transferability probe
 * (src/checks/security.ts's `checkTransferable`): reads Transfer events for `token` over the
 * last ~9500 blocks and returns the unique recipient addresses, newest-first. NEVER throws —
 * any failure (bad RPC, chain tip below the window, malformed logs) degrades to `[]`, which
 * `checkTransferable` already treats as "no candidates" -> 'unknown'.
 */
export async function recentHolders(evm: Evm, token: string): Promise<string[]> {
  try {
    const tip = await evm.blockNumber();
    const from = Math.max(0, tip - LOG_RANGE_BLOCKS);
    const logs = await evm.getLogs({
      address: token,
      topics: [TRANSFER_TOPIC],
      fromBlock: '0x' + from.toString(16),
      toBlock: 'latest',
    });

    // Transfer(address indexed from, address indexed to, uint256 value) -> recipient is topics[2].
    // Logs come back oldest-first; reverse to get newest-first before de-duping.
    const seen = new Set<string>();
    const recipients: string[] = [];
    for (const log of [...logs].reverse()) {
      const to = decodeAddress(log.topics[2]).toLowerCase();
      if (DEAD_ADDRESSES.has(to) || seen.has(to)) continue;
      seen.add(to);
      recipients.push(to);
    }
    return recipients;
  } catch {
    return [];
  }
}
