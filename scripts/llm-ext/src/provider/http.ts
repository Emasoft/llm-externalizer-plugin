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
 * Fetch with a timeout that covers the WHOLE exchange — connect, headers, AND
 * the body read.
 *
 * THE BUG THIS FIXES (TRDD-0H5N1V9W), because the naive shape is subtly wrong:
 *
 *     const timer = setTimeout(() => controller.abort(), timeoutMs);
 *     try { return await fetch(url, {...options, signal: controller.signal}); }
 *     finally { clearTimeout(timer); }          // <-- fires at HEADERS
 *
 * `fetch()` resolves as soon as response HEADERS arrive, NOT when the body has
 * been consumed. So that `finally` disarmed the abort the instant headers
 * landed, and the caller then read the body with no deadline whatsoever — the
 * timeout bounded time-to-first-byte only. A model that returned headers
 * promptly and then stalled mid-generation hung forever: the retry ladder never
 * fired, because a retry needs a RESPONSE and there is none. Measured: a
 * session-summary chunk ran 1890s against a 300s cap (6.3x) before its socket
 * died, while fetchWithRetry429's `remaining = timeout - elapsed` arithmetic
 * believed the request had long since expired.
 *
 * The fix keeps the controller ARMED through the body read and disarms it only
 * once the body settles, so an over-deadline generation ABORTS LOUDLY and can
 * rotate like any other transient — fail-fast instead of a silent hang.
 *
 * Raising `timeoutMs` is NOT an alternative fix: it turns an unbounded hang into
 * a longer unbounded hang.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = CONNECT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let disarmed = false;
  const disarm = () => {
    if (disarmed) return;
    disarmed = true;
    clearTimeout(timer);
  };

  let res: Response;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    // Never leak the timer when the request fails outright.
    disarm();
    throw err;
  }

  // 204/304/HEAD and some runtimes give a null body — nothing left to bound, and
  // the Response constructor REJECTS a body for those statuses, so returning the
  // original object is both correct and necessary.
  if (!res.body) {
    disarm();
    return res;
  }

  // Pass-through tap whose terminal callbacks disarm the timer. `flush` covers
  // the body ending normally; `cancel` covers the consumer walking away (an
  // early return, or a caller that never reads). Without `cancel` an unread body
  // would leave the timer armed to fire later against a response nobody wants.
  const tapped = res.body.pipeThrough(
    new TransformStream({
      flush: disarm,
      cancel: disarm,
    }),
  );

  // Rebuilt rather than mutated because Response.body is read-only. Safe here:
  // no caller in this codebase reads `url`, `redirected`, or `type` (the fields
  // reconstruction does not carry over) — verified before making this change.
  return new Response(tapped, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
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

/**
 * Collapse a raw provider HTTP-error body into a short, privacy-safe reason.
 *
 * OpenRouter (and other backends) return a large JSON error envelope that
 * embeds the account `user_id` plus nested metadata. Baking that raw body
 * verbatim into the thrown Error message means it (a) floods the console on
 * every retry and (b) gets written into report files — noisy AND a privacy leak
 * of the account id into a file the user may share. This keeps only the
 * human-readable message + the upstream provider detail, capped, and scrubs any
 * id / key tokens.
 *
 * SAFETY: callers prepend `API error <status> (<backend>): ` themselves, so the
 * status code that index.ts's classifyError() regex-matches (`/API error 429\b/`
 * etc.) is OUTSIDE what this returns and is always preserved — this only cleans
 * the response-body portion. Kept as a pure exported function so it is
 * unit-tested offline with zero spend (provider-error-sanitize.test.ts).
 *
 * Lives here (B1 Phase 5b) rather than in completion.ts because it is a
 * stateless transform of an HTTP response body — the same layer that produced
 * it — and http.ts is the module that is guaranteed dependency-free.
 */
export function sanitizeProviderError(raw: string, maxLen = 200): string {
  const stripTokens = (s: string): string =>
    s
      // OpenRouter account id — "user_id":"user_..." (the privacy leak)
      .replace(/"?user_?id"?\s*[:=]\s*"?[\w.-]+"?/gi, "")
      // any API-key-looking token that should never reach a log / report
      .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***")
      .replace(/\s+/g, " ")
      .trim();

  if (!raw || !raw.trim()) return "(no response body)";

  // Assigned on both paths below (try: `reason = msg`; catch: `reason = raw`),
  // so no initializer is needed — and an `= ""` here trips no-useless-assignment.
  let reason: string;
  try {
    const parsed = JSON.parse(raw) as {
      error?: {
        message?: string;
        metadata?: { raw?: string; provider_name?: string };
      };
      message?: string;
    };
    const errObj = parsed.error ?? parsed;
    const msg = typeof errObj?.message === "string" ? errObj.message.trim() : "";
    const meta = parsed.error?.metadata;
    const detail = typeof meta?.raw === "string" ? meta.raw.trim() : "";
    const provider =
      typeof meta?.provider_name === "string" ? meta.provider_name.trim() : "";
    // Order matters: msg + provider first, then the verbose upstream detail —
    // so the provider survives the length cap instead of being truncated off.
    reason = msg;
    if (provider) reason = reason ? `${reason} [${provider}]` : provider;
    if (detail && !detail.startsWith(msg)) {
      reason = reason ? `${reason}: ${detail}` : detail;
    }
  } catch {
    // Not JSON (HTML error page, plain text, truncated body) — fall back to raw.
    reason = raw;
  }

  reason = stripTokens(reason || raw);
  if (reason.length > maxLen) reason = reason.slice(0, maxLen - 1) + "…";
  return reason || "(unparseable error body)";
}
