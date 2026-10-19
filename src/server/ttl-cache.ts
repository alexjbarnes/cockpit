/**
 * A tiny in-process cache with per-entry expiry. Cockpit is one process, so
 * this is a Map and nothing more, and entries die with the server — the right
 * lifetime for data that is only ever a copy of something held elsewhere.
 *
 * There is no sweeping: an entry goes when it is read after its expiry, or
 * when a writer invalidates it. An expired entry that is never read again
 * costs the memory it holds and nothing else.
 */
export class TtlCache<V> {
  private entries = new Map<string, { value: V; expiresAt: number }>();

  /** The clock is injectable so a test can expire an entry without waiting. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Drop a family of keys at once, for the reads whose keys vary (a repo's PR
   *  lists) and are made wrong together by one write. */
  deleteByPrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
