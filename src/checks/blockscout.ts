export async function isVerified(
  addr: string,
  baseUrl: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<boolean | 'unknown'> {
  try {
    const url = `${baseUrl}/api/v2/smart-contracts/${addr}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetchFn(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });

      if (response.status === 200) {
        return true;
      }

      if (response.status === 404) {
        return false;
      }

      // Any other status
      return 'unknown';
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Catch all errors: network errors, timeouts, abort errors, etc.
    return 'unknown';
  }
}
