// Benchmark fixture — real code with a KNOWN feature location (TRDD-828238b5 A6).
// Feature: debounce utility delaying function execution.

/**
 * Return a debounced wrapper: calls are delayed by `waitMs` and only the
 * LAST call within the window executes. `cancel()` drops a pending call.
 */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number,
): { (...args: Args): void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = (...args: Args): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, waitMs);
  };
  debounced.cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return debounced;
}
