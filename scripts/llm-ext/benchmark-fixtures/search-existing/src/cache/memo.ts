// Benchmark fixture — real code with a KNOWN feature location (TRDD-828238b5 A6).
// Feature: function memoization keyed by the call's arguments (unbounded —
// deliberately NO eviction so the "LRU cache" dataset case has an unambiguous
// NO here: there is no max size and no eviction policy in this file).

/**
 * Wrap a function so repeated calls with the same arguments return the cached
 * result instead of recomputing. Arguments are keyed by JSON serialization,
 * so they must be JSON-safe (primitives, plain objects, arrays).
 */
export function memoize<Args extends unknown[], R>(
  fn: (...args: Args) => R,
): (...args: Args) => R {
  const cache = new Map<string, R>();
  return (...args: Args): R => {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key) as R;
    const result = fn(...args);
    cache.set(key, result);
    return result;
  };
}
