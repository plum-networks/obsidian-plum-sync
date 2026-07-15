// SHA-256 (hex) of file content — the same value the box indexes as
// content_hash, so a matching hash means the two sides are byte-identical and
// no transfer is needed. SubtleCrypto is available in Obsidian on desktop and
// mobile.
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

/** Run `fn` over items with at most `n` in flight. Preserves error isolation:
 *  a rejected item rejects the whole batch (caller wraps per-item as needed). */
export async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}
