// Benchmark fixture — real code with a KNOWN feature location (TRDD-828238b5 A6).
// Feature: retry with exponential backoff. Lives OUTSIDE src/ on purpose: the
// search-existing benchmark walks this tree with the REAL pipeline, so these
// files must never be compiled, linted, or tested by the package toolchain.

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULTS: RetryOptions = { attempts: 4, baseDelayMs: 250, maxDelayMs: 8000 };

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Run an async operation, retrying on failure with exponential backoff.
 * Delay doubles each attempt, capped at maxDelayMs. The last error is
 * rethrown when all attempts are exhausted.
 */
export async function withRetry<T>(
  op: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...DEFAULTS, ...options };
  let lastError: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastError = err;
      if (attempt === opts.attempts - 1) break;
      const delay = Math.min(opts.baseDelayMs * 2 ** attempt, opts.maxDelayMs);
      await sleep(delay);
    }
  }
  throw lastError;
}
