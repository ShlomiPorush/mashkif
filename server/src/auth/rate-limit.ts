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

  async consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    const now = this.clock();
    const windowMs = rule.window * 1000;
    const entry = this.#entries.get(key);
    if (entry === undefined || now - entry.start >= windowMs) {
      this.#prune(now);
      this.#entries.set(key, { start: now, count: 1, window: windowMs });
      return { allowed: true, retryAfter: null };
    }
    if (entry.count >= rule.max) {
      return { allowed: false, retryAfter: Math.ceil((entry.start + windowMs - now) / 1000) };
    }
    entry.count += 1;
    return { allowed: true, retryAfter: null };
  }

  clear(): void {
    this.#entries.clear();
  }

  #prune(now: number): void {
    if (this.#entries.size < MAX_ENTRIES) {
      return;
    }
    for (const [key, entry] of this.#entries) {
      if (now - entry.start >= entry.window) {
        this.#entries.delete(key);
      }
    }
    // Still full: drop the oldest entries rather than grow without bound.
    for (const key of this.#entries.keys()) {
      if (this.#entries.size < MAX_ENTRIES) {
        break;
      }
      this.#entries.delete(key);
    }
  }
}
