// Benchmark fixture — real code with a KNOWN feature location (TRDD-828238b5 A6).
// Feature: ALSO retry-with-backoff, but coded differently (inline while-loop,
// jittered linear-then-doubling delay) inside a fetch helper. Exists to test
// SEMANTIC duplicate detection and the EXHAUSTIVE multi-match requirement:
// a correct run reports BOTH this file and src/http/retry.ts.

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * GET a JSON document. Transient failures (network error or HTTP 5xx) are
 * retried up to `maxTries` times; the wait between tries starts at 200 ms
 * and doubles after each failure, with a small random jitter.
 */
export async function fetchJson<T>(url: string, maxTries = 3): Promise<T> {
  let tries = 0;
  let waitMs = 200;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    tries += 1;
    try {
      const res = await fetch(url);
      if (res.status >= 500) {
        throw new HttpError(res.status, `server error ${res.status}`);
      }
      if (!res.ok) {
        throw new HttpError(res.status, `request failed ${res.status}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      const retryable =
        !(err instanceof HttpError) || (err.status >= 500 && err.status < 600);
      if (!retryable || tries >= maxTries) throw err;
      const jitter = Math.floor(Math.random() * 50);
      await new Promise((res) => setTimeout(res, waitMs + jitter));
      waitMs *= 2;
    }
  }
}
