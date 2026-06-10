// Benchmark fixture — real code (TRDD-828238b5 A6). This file is a NEGATIVE
// for every dataset case: array chunking matches none of the benchmarked
// feature descriptions.

/** Split an array into consecutive chunks of at most `size` elements. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunk size must be a positive integer, got ${size}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
