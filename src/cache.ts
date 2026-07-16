export type CachePolarity = "positive" | "negative";

export interface CacheEntry<V> {
  readonly value: V;
  readonly polarity: CachePolarity;
}

export interface BoundedTtlCacheOptions {
  readonly maxEntries: number;
  readonly positiveTtlMs: number;
  readonly negativeTtlMs: number;
  readonly now?: () => number;
}

interface StoredEntry<V> extends CacheEntry<V> {
  readonly expiresAt: number;
}

/** A bounded LRU-ish cache with intentionally shorter negative-result TTLs. */
export class BoundedTtlCache<K, V> {
  readonly #entries = new Map<K, StoredEntry<V>>();
  readonly #options: BoundedTtlCacheOptions;
  readonly #now: () => number;

  constructor(options: BoundedTtlCacheOptions) {
    if (options.maxEntries < 1) throw new Error("maxEntries must be positive");
    if (options.positiveTtlMs < 0 || options.negativeTtlMs < 0) {
      throw new Error("cache TTLs cannot be negative");
    }
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    this.#pruneExpired();
    return this.#entries.size;
  }

  get(key: K): CacheEntry<V> | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }

    // Reinsert so the oldest map entry remains the eviction candidate.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return { value: entry.value, polarity: entry.polarity };
  }

  set(key: K, value: V, polarity: CachePolarity = "positive"): void {
    const ttl =
      polarity === "positive"
        ? this.#options.positiveTtlMs
        : this.#options.negativeTtlMs;
    this.#entries.delete(key);
    this.#entries.set(key, {
      value,
      polarity,
      expiresAt: this.#now() + ttl,
    });
    this.#evictOverflow();
  }

  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  #pruneExpired(): void {
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }

  #evictOverflow(): void {
    this.#pruneExpired();
    while (this.#entries.size > this.#options.maxEntries) {
      const oldest = this.#entries.keys().next().value as K | undefined;
      if (oldest === undefined) return;
      this.#entries.delete(oldest);
    }
  }
}
