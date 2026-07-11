/**
 * provider/http.ts — the HTTP transport primitives (B1 Phase 5, TRDD-63314265).
 *
 * Extracted verbatim from index.ts. This layer is deliberately STATELESS: it
 * knows nothing about backends, models, auth or accounting — it just moves
 * bytes with a connect timeout and a bounded retry policy. That is why it needs
 * no ProviderDeps and imports NOTHING from index.ts.
 */

export const CONNECT_TIMEOUT_MS = 5000;

/**
 * Fetch with a connect timeout so Claude doesn't hang when the host is offline.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = CONNECT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch with exponential backoff retry for transient errors.
 *
 * Retries on:
 *   429 (rate limited) — respects Retry-After header as minimum delay
 *   500, 502, 503, 504 — transient server errors
 *
 * Backoff strategy:
 *   - Base delay: 1s, doubles each attempt (1s → 2s → 4s → 8s → 16s)
 *   - Jitter: ±25% randomization to prevent thundering herd across processes
 *   - Retry-After floor: if server says "wait 10s", delay is max(backoff, 10s)
 *   - Max 5 retries (6 total attempts), capped by remaining time budget
 *   - Gives up immediately if remaining time < 2s (not enough for a useful retry)
 */
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export async function fetchWithRetry429(
  url: string,
  fetchOpts: RequestInit,
  timeout: number,
  startTime: number,
  // A1/A7 model-health: optional accumulator so the model-aware CALLER (which
  // knows the model id this helper lacks) can emit a single durable
  // `rate_limit_429` event PER CALL that hit ≥1 429. Set-only here; reading +
  // emission happen at the caller. Purely observational — never alters
  // retry/backoff/return behaviour.
  out?: { saw429: boolean },
): Promise<Response> {
  let lastRes: Response | undefined;
  // Capture the error body text before draining it (the body stream is
  // single-shot; if we drain to free the connection between retries and
  // then exhaust retries, the caller's `await res.text()` would return ""
  // and the surfaced HTTP error would have no server-supplied detail).
  // Stored verbatim so the caller can re-attach via the rewrapper below.
  let lastBodyText: string | undefined;
  // Issue 3: count 429s for this request so we can log only the first + a final
  // summary instead of one line per retried attempt (free-tier rate-limit flood).
  let count429 = 0;

  for (let attempt = 0; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    const elapsed = Date.now() - startTime;
    const remaining = timeout - elapsed;

    // Not enough time for a meaningful retry
    if (attempt > 0 && remaining < 2000) {
      break;
    }

    try {
      lastRes = await fetchWithTimeout(url, fetchOpts, Math.max(remaining, 1000));
    } catch (err) {
      // Network errors (ECONNRESET, ETIMEDOUT, etc.) are retryable
      if (attempt >= RETRY_MAX_ATTEMPTS) throw err;

      const backoff = computeBackoffMs(attempt, 0);
      const waitRemaining = timeout - (Date.now() - startTime);
      if (backoff > waitRemaining) throw err;

      process.stderr.write(
        `[http-retry] Network error (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS + 1}), ` +
        `retrying in ${(backoff / 1000).toFixed(1)}s: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }

    // Success or non-retryable status — return immediately
    if (!RETRYABLE_STATUS.has(lastRes.status)) {
      return lastRes;
    }

    // Last attempt — return whatever we got
    if (attempt >= RETRY_MAX_ATTEMPTS) {
      break;
    }

    // Parse Retry-After header (seconds or HTTP-date) as minimum delay floor
    let retryAfterMs = 0;
    if (lastRes.status === 429) {
      const retryAfter = lastRes.headers.get("retry-after");
      if (retryAfter) {
        const parsed = Number(retryAfter);
        if (Number.isFinite(parsed)) {
          retryAfterMs = parsed * 1000;
        } else {
          const dateMs = Date.parse(retryAfter);
          if (!isNaN(dateMs)) {
            retryAfterMs = Math.max(0, dateMs - Date.now());
          }
        }
      }
    }

    const backoff = computeBackoffMs(attempt, retryAfterMs);
    const waitRemaining = timeout - (Date.now() - startTime);

    // Not enough time to wait + retry
    if (backoff > waitRemaining) {
      break;
    }

    // Issue 2/3: tag the HTTP retry layer ([http-retry]) and collapse the 429
    // flood. The free tier's per-minute cap makes a single ensemble call emit
    // dozens of 429s; we log the FIRST 429 for this request and a single summary
    // on the last retried attempt, suppressing the middle ones. Non-429 transient
    // statuses (500/502/503/504) still log every attempt (rarer, each diagnostic).
    // Retry behaviour (backoff/continue/break) is unchanged — only log frequency.
    if (lastRes.status === 429) {
      count429++;
      // Record (set-only, idempotent) that this CALL hit a 429 so the caller can
      // emit ONE durable rate_limit_429 event for the call — not one per attempt.
      if (out) out.saw429 = true;
      if (count429 === 1) {
        process.stderr.write(
          `[http-retry] HTTP 429 rate-limited (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS + 1}), ` +
          `retrying in ${(backoff / 1000).toFixed(1)}s\n`,
        );
      } else if (attempt === RETRY_MAX_ATTEMPTS - 1) {
        process.stderr.write(
          `[http-retry] HTTP 429 ×${count429} (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS + 1}), ` +
          `retrying in ${(backoff / 1000).toFixed(1)}s\n`,
        );
      }
    } else {
      process.stderr.write(
        `[http-retry] HTTP ${lastRes.status} (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS + 1}), ` +
        `retrying in ${(backoff / 1000).toFixed(1)}s\n`,
      );
    }

    // Capture the body text BEFORE draining (replaces the previous
    // discard-to-free-connection pattern that wiped server-supplied error
    // detail before the caller could read it).
    lastBodyText = await lastRes.text().catch(() => "");
    await new Promise((r) => setTimeout(r, backoff));
  }

  // All retries exhausted — return a re-wrapped Response so the caller's
  // `await res.text()` still sees the most-recent server-supplied error
  // body. The previous version returned the original (already-consumed)
  // Response, leaving callers to throw `API error 502: ` with no detail.
  if (lastRes) {
    if (lastBodyText === undefined) return lastRes;
    return new Response(lastBodyText, {
      status: lastRes.status,
      statusText: lastRes.statusText,
      headers: lastRes.headers,
    });
  }
  throw new Error("API request failed — all retries exhausted with no response");
}

/** Exponential backoff with jitter. retryAfterMs is a floor from the server. */
export function computeBackoffMs(attempt: number, retryAfterMs: number): number {
  // Exponential: 1s, 2s, 4s, 8s, 16s
  const exponential = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
  // Use the larger of exponential backoff or server-requested delay
  const base = Math.max(exponential, retryAfterMs);
  // Cap at max delay
  const capped = Math.min(base, RETRY_MAX_DELAY_MS);
  // Add ±25% jitter to prevent thundering herd across concurrent processes
  const jitter = capped * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}
