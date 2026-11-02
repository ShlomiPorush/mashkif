/** A rate-limit rule: at most `max` requests per `window` seconds. */
export interface RateLimitRule {
  window: number;
  max: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfter: number | null;
}

const MAX_ENTRIES = 100_000;

/**
 * Fixed-window rate-limit store for Better Auth, kept in this process. One
 * instance per auth instance, so tests can start from a clean state; the
 * server runs as a single process.
 */
export class MemoryRateLimitStore {
  readonly #entries = new Map<string, { start: number; count: number; window: number }>();

  constructor(private readonly clock: () => number = Date.now) {}

  /** Counts a request of the given cost (1 by default) and decides whether it is allowed. */
  async consume(key: string, rule: RateLimitRule, cost = 1): Promise<RateLimitDecision> {
    const now = this.clock();
    const windowMs = rule.window * 1000;
    const entry = this.#entries.get(key);
    if (entry === undefined || now - entry.start >= windowMs) {
      // Deleted and set again, so the map stays ordered by window start.
      this.#entries.delete(key);
      this.#prune(now);
      this.#entries.set(key, { start: now, count: cost, window: windowMs });
      return { allowed: true, retryAfter: null };
    }
    if (entry.count >= rule.max) {
      return { allowed: false, retryAfter: Math.ceil((entry.start + windowMs - now) / 1000) };
    }
    entry.count += cost;
    return { allowed: true, retryAfter: null };
  }

  /** Entries kept, for tests. */
  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }

  /**
   * Drops expired entries from the oldest end, then, if still full, the
   * oldest entries. Each entry is dropped at most once, so this costs O(1)
   * per request on average instead of a scan of the whole map.
   */
  #prune(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (now - entry.start < entry.window) {
        break;
      }
      this.#entries.delete(key);
    }
    for (const key of this.#entries.keys()) {
      if (this.#entries.size < MAX_ENTRIES) {
        break;
      }
      this.#entries.delete(key);
    }
  }
}
