// Benchmark fixture — real code with a KNOWN feature location (TRDD-828238b5 A6).
// Feature: in-memory LRU cache with max-size eviction. Deliberately a bare
// data structure (get/set/delete only, NO get-or-compute helper) so that the
// "function memoization" dataset case has an unambiguous NO here: composing
// memoization on top would require writing the wrap-and-key logic yourself.

export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly maxSize: number) {
    if (!Number.isInteger(maxSize) || maxSize <= 0) {
      throw new Error(`maxSize must be a positive integer, got ${maxSize}`);
    }
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    // Re-insert to mark as most-recently-used (Map preserves insertion order).
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.maxSize) {
      // Oldest entry is the first key in insertion order.
      const oldest = this.entries.keys().next().value as K;
      this.entries.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
