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
 * OpenRouter attribution headers sent on every decisions request (plan section 7).
 * A fixed constant, not profile config: index.ts sends a configurable X-Title (a different header name), so this is the one identity decisions traffic reports.
 */
export const OPENROUTER_ATTRIBUTION_HEADERS = {
  "HTTP-Referer": "https://github.com/Emasoft/llm-externalizer-plugin",
  "X-OpenRouter-Title": "llm-externalizer",
} as const;

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
export const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);


/** Wall-clock window for retrying one logical call, measured from its FIRST
 *  failure. Independent of the settings.yaml request timeout, which bounds a
 *  single request, not the whole retry story. */
export const RETRY_DEADLINE_MS = 300_000;

/**
 * The retry clock of one logical call (TRDD-YG72CYY7 increment 1).
 *
 * WHY it starts at the first failure, not at entry: a call that succeeds first
 * time (or spends minutes generating) must not have its retry budget eaten by
 * that time; "5 minutes of retrying" means five minutes after something went
 * wrong. An explicit `deadlineAt` (from SimpleCompletionOptions) wins.
 *
 * WHY it only gates the START of a new attempt or wait and never aborts a
 * request in flight: an in-flight generation may be about to succeed and has
 * its own timeout (fetchWithTimeout); killing it at the clock would turn paid
 * work into a loss. The clock is consulted only before spending more time.
 */
export interface RetryClock {
  deadlineAt?: number;
  /** Set when the first failure started the clock. */
  startedAt?: number;
  /** Set once a wait or attempt was refused for lack of time. One flag for the
   *  whole dispatch under a shared clock: one slot refusing a wait that does not
   *  fit means the dispatch has no time for a further wait either, so closing the
   *  window for every slot keeps the "5 minutes per logical call" bound. */
  expired?: boolean;
  /** HTTP requests started under this clock. Dispatch-wide under a shared clock. */
  attempts?: number;
  /** Status of the NEWEST attempt; cleared when that attempt failed without a response.
   *  Dispatch-wide under a shared clock, interleaved across concurrent slots. */
  lastStatus?: number;
  /** provider_name of the NEWEST attempt's error body, when it carried one.
   *  Dispatch-wide under a shared clock. */
  lastProvider?: string;
  /** The newest error seen under this clock. Dispatch-wide under a shared clock.
   *  WHY: a call can start after another call closed the window, before it has
   *  an error of its own; without this it would throw a RetryDeadlineError with
   *  no cause. */
  lastError?: unknown;
}

export function startRetryClock(clock: RetryClock | undefined): void {
  if (!clock || clock.startedAt !== undefined) return;
  clock.startedAt = Date.now();
  clock.deadlineAt ??= clock.startedAt + RETRY_DEADLINE_MS;
}


/**
 * A per-call view of a (possibly dispatch-wide shared) retry clock whose
 * deadline is pushed back by THIS call's broker queue time only (review M10,
 * TRDD-1OOAH3LD spec 4). The queue time must never be added to the shared
 * object: with W = 64 slots each adding its own wait, the shared deadline
 * grew by the SUM of all waits and the 5-minute window of TRDD-YG72CYY7 was
 * silently switched off for every model of the dispatch. Every other field
 * (and every write, including the first-failure deadline) goes to the shared
 * clock unchanged.
 */
export function clockForCall(shared: RetryClock, call: { brokerQueuedMs?: number }): RetryClock {
  return new Proxy(shared, {
    get(target, prop, receiver) {
      if (prop === "deadlineAt") return target.deadlineAt === undefined ? undefined : target.deadlineAt + (call.brokerQueuedMs ?? 0);
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

/** True when the clock has a deadline and it has passed or a wait was refused. */
export function retryWindowClosed(clock: RetryClock): boolean {
  return (
    clock.startedAt !== undefined &&
    (clock.expired === true || (clock.deadlineAt !== undefined && Date.now() >= clock.deadlineAt))
  );
}

/** Whether waiting `waitMs` still leaves time to start the next attempt. When
 *  not, marks the clock expired so the caller stops instead of waiting past it.
 *  An already-expired clock refuses every wait: a refused breaker wait must not
 *  be followed by a shorter wait that happens to fit before the deadline. */
export function waitFitsClock(clock: RetryClock | undefined, waitMs: number): boolean {
  if (!clock || clock.deadlineAt === undefined) return true;
  if (clock.expired === true) return false;
  if (Date.now() + waitMs < clock.deadlineAt) return true;
  clock.expired = true;
  return false;
}

export interface RetryTrail {
  attempts: number;
  elapsedMs: number;
  lastStatus?: number;
  lastProvider?: string;
}

/**
 * The retry window closed. WHY the message is neutral (no "transient" or
 * "temporary"): the same text is read by humans and by classifiers downstream,
 * and those words made earlier callers treat a final verdict as "try again".
 * The last underlying error is `.cause`.
 */
export class RetryDeadlineError extends Error {
  readonly code = "RETRY_DEADLINE";
  readonly trail: RetryTrail;
  /** Epoch ms when the provider said a retry may succeed (rate-limit only). */
  readonly retryAt?: number;
  /** True when the SHARED window is closed (deadline passed, or a wait that did
   *  not fit the remaining window was refused): no call of the dispatch has time
   *  left. False when only THIS call stopped because a provider's Retry-After
   *  lies beyond the window: other models of the dispatch may still answer. */
  /** False also for a call that owns a PRIVATE clock (round C0a item 1): its
   *  window is its own, the next model gets a fresh one, so its deadline error
   *  is an ordinary failure of that model, not a closed dispatch. */
  readonly dispatchClosed: boolean;
  /** How consumers label `.cause`: the cause may be another call's error (this
   *  call had none of its own when the shared window was already closed). */
  readonly causeLabel: string;

  constructor(trail: RetryTrail, cause: unknown, retryAt?: number, dispatchClosed = true, foreignCause = false) {
    const seen = `${trail.attempts} request(s) over ${Math.round(trail.elapsedMs / 1000)}s` +
      `, last status ${trail.lastStatus ?? "none"}` +
      (trail.lastProvider ? ` from ${trail.lastProvider}` : "");
    super(
      retryAt !== undefined
        ? `Rate limit: the provider asked to wait until ${new Date(retryAt).toISOString()}, which is beyond the retry window (${seen}). Retry after that time.`
        : `Retry window closed without a successful answer (${seen}).`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "RetryDeadlineError";
    this.trail = trail;
    this.retryAt = retryAt;
    this.dispatchClosed = dispatchClosed;
    this.causeLabel = foreignCause ? "Last error seen in this dispatch:" : "Last error:";
  }
}


/**
 * The text a message-based classifier (classifyUnavailable, the endpoint-dead
 * test, paymentErrorCertainty) must read for `err`. A RetryDeadlineError's own
 * message is deliberately neutral, so the real failure ("API error 500 ...
 * overloaded", "fetch failed ECONNREFUSED") lives in its `.cause`; classifying
 * the neutral message instead made rotation treat an availability failure as a
 * defect and a dead endpoint look alive. Every other error is read as before.
 */
export function failureText(err: unknown): string {
  const source = err instanceof RetryDeadlineError && err.cause !== undefined ? err.cause : err;
  return source instanceof Error ? source.message : String(source);
}

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
  // `refusedRetryAt`: set when a provider's Retry-After lies beyond the window.
  // It is reported to the CALLER (call-local) and never written to the shared
  // clock: one model's own wait refusal must not close the window for the rest of
  // the dispatch (the next model may answer at once).
  out?: { saw429: boolean; refusedRetryAt?: number },
  // Retry clock (TRDD-YG72CYY7 inc 1): gates the START of the next attempt or
  // wait only; a request already in flight is never aborted by it.
  clock?: RetryClock,
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
  const host = hostOf(url);
  // Failures per verdict budget key (504, ECONNREFUSED, dns), counted across attempts of this call.
  const tally: Record<string, number> = {};
  // The verdict of a status response (504 budget); registered on the returned Response below.
  const stamp: { final?: "stop" | "budget"; hint?: string } = {};
  // D7: name-lookup failures on the OpenRouter host never left the machine, so they do not consume
  // RETRY_MAX_ATTEMPTS; this only lengthens their backoff.
  let freeSteps = 0;
  // The network error of the NEWEST attempt; cleared when a response arrives. WHY: a loop that ends on the
  // time check must rethrow it (not the generic text, and not an older attempt's stale response).
  let newestNetworkError: unknown;

  for (let attempt = 0; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    const elapsed = Date.now() - startTime;
    const remaining = timeout - elapsed;

    // WHY `|| freeSteps > 0`: a given-back attempt keeps `attempt` at 0 forever, so without it the request-timeout
    // bound below would never apply to a run of name-lookup failures.
    const retrying = attempt > 0 || freeSteps > 0;
    // The time check can end the loop with the newest outcome being a network error; rethrow that error (fields
    // attached) instead of the generic "no response" text or an older attempt's response.
    if (retrying && remaining < 2000 && newestNetworkError !== undefined) {
      if (clock) clock.lastError = newestNetworkError;
      throw newestNetworkError;
    }

    // Not enough time for a meaningful retry
    if (retrying && remaining < 2000) {
      break;
    }

    try {
      if (clock) clock.attempts = (clock.attempts ?? 0) + 1;
      lastRes = await fetchWithTimeout(url, fetchOpts, Math.max(remaining, 1000));
      newestNetworkError = undefined;
      if (clock) {
        // Status and provider describe the NEWEST attempt only; the provider is
        // set below, once a retryable response body has been read.
        clock.lastStatus = lastRes.status;
        clock.lastProvider = undefined;
      }
    } catch (err) {
      // A network failure is the NEWEST outcome: forget the status of the
      // previous attempt, or the final error's trail would claim "last status
      // 429" for a call that actually ended in ECONNRESET (and a message-based
      // classifier would then read that stale 429).
      if (clock) {
        clock.lastStatus = undefined;
        clock.lastProvider = undefined;
      }
      // Attached before every rethrow and the sleep: the code of the NEWEST failure rides on the error.
      const fields: FailureFields = { networkCode: networkCodeOf(err, url) };
      if (err instanceof Error) attachFailure(err, fields);
      newestNetworkError = err;
      // The verdict is taken at the FIRST failure, before the clock starts and before any sleep.
      const verdict = classifyFailure(fields, host);
      if (settleVerdict(verdict, fields, tally)) {
        if (clock) clock.lastError = err;
        throw err;
      }
      const givesBack = !consumesAttempt(verdict, clock);
      // Network errors (ECONNRESET, ETIMEDOUT, etc.) are retryable. lastError is
      // recorded only on the paths that throw the error out (a recovered blip
      // must not become the cause of a later deadline error). chatCompletionJSON
      // has no retry wrapper, so this is where it gets one; a retryable HTTP
      // status is recorded by the caller, which builds the thrown text.
      if (!givesBack && attempt >= RETRY_MAX_ATTEMPTS) {
        if (clock) clock.lastError = err;
        throw err;
      }

      startRetryClock(clock);
      const backoff = computeBackoffMs(attempt + freeSteps, 0);
      // Never wait past the retry clock (marks it expired; caller stops).
      if (!waitFitsClock(clock, backoff)) {
        if (clock) clock.lastError = err;
        throw err;
      }
      const waitRemaining = timeout - (Date.now() - startTime);
      if (backoff > waitRemaining) {
        if (clock) clock.lastError = err;
        throw err;
      }

      process.stderr.write(
        `[http-retry] Network error (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS + 1}), ` +
        `retrying in ${(backoff / 1000).toFixed(1)}s: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      await new Promise((r) => setTimeout(r, backoff));
      if (givesBack) {
        freeSteps++;
        attempt--; // the loop increment gives this attempt back
      }
      continue;
    }

    // Success or non-retryable status — return immediately
    if (!RETRYABLE_STATUS.has(lastRes.status)) {
      return lastRes;
    }

    // Capture the body text BEFORE any decision to stop or wait (replaces the
    // previous discard-to-free-connection pattern that wiped server-supplied
    // error detail before the caller could read it). It must happen here, not
    // just before the sleep: every `break` below leaves the loop with THIS
    // response, and a break taken before the read returned this attempt's
    // status paired with the PREVIOUS attempt's body (a 429 Retry-After reply
    // arrived carrying an earlier 503's text, so the daily-quota wording that
    // identifies it was lost).
    lastBodyText = await lastRes.text().catch(() => "");
    if (clock) clock.lastProvider = providerNameFromBody(lastBodyText);

    // First-failure verdict of a status response (504 budget), taken before the clock starts.
    if (settleVerdict(classifyFailure(httpFailureFields(lastRes, lastBodyText), host), stamp, tally)) {
      break;
    }

    // Last attempt — return whatever we got
    if (attempt >= RETRY_MAX_ATTEMPTS) {
      break;
    }

    // Parse Retry-After header (seconds or HTTP-date) as minimum delay floor
    const retryAfterMs = lastRes.status === 429 ? (retryAfterMsOf(lastRes.headers) ?? 0) : 0;

    startRetryClock(clock);
    // Retry-After beyond the window: waiting it out is impossible, so stop NOW
    // (not after sleeping a capped backoff and asking again) and record when a
    // retry may succeed; the caller reports cause rate-limit with that time.
    // Taken ONLY when the provider actually supplied a Retry-After (a plain 5xx
    // has retryAfterMs 0 and falls through to waitFitsClock, which marks the
    // clock expired WITHOUT a retryAt). WHY no `windowLeft >= 0` guard (N6): an
    // attempt in flight across the deadline leaves `windowLeft` negative, and a
    // supplied Retry-After is still longer than that, so dropping it made the
    // final error say "window closed" without the time the provider asked for.
    if (clock?.deadlineAt !== undefined) {
      const windowLeft = clock.deadlineAt - Date.now();
      if (retryAfterMs > 0 && retryAfterMs > windowLeft) {
        if (out) out.refusedRetryAt = Date.now() + retryAfterMs;
        break;
      }
    }

    const backoff = computeBackoffMs(attempt, retryAfterMs);
    const waitRemaining = timeout - (Date.now() - startTime);
    if (!waitFitsClock(clock, backoff)) {
      break;
    }

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

    await new Promise((r) => setTimeout(r, backoff));
  }

  // All retries exhausted — return a re-wrapped Response so the caller's
  // `await res.text()` still sees the most-recent server-supplied error
  // body. The previous version returned the original (already-consumed)
  // Response, leaving callers to throw `API error 502: ` with no detail.
  if (lastRes) {
    if (lastBodyText === undefined) return lastRes;
    // The re-wrapped body replaces lastRes's own, which now nobody will ever
    // read. Cancel it explicitly: fetchWithTimeout keeps its abort timer ARMED
    // until the body settles (that is what made the deadline cover generation),
    // so an abandoned body would hold Node's event loop open for the rest of
    // this request's budget — minutes — after the command had finished. The
    // tap's `cancel` callback is what disarms it. Already-consumed bodies
    // reject here; that is the harmless case, hence the swallow.
    void lastRes.body?.cancel().catch(() => {});
    const rewrapped = new Response(lastBodyText, {
      status: lastRes.status,
      statusText: lastRes.statusText,
      headers: lastRes.headers,
    });
    // WHY a WeakMap on the Response: the throw site holds only the Response, never an Error, when a status stops on a verdict.
    if (stamp.final) RESPONSE_VERDICTS.set(rewrapped, { final: stamp.final, hint: stamp.hint });
    return rewrapped;
  }
  throw new Error("API request failed — all retries exhausted with no response");
}

/** Applies a verdict to the object that carries `final`/`hint`; true when the call must stop now. */
function settleVerdict(
  verdict: FailureVerdict,
  target: { final?: "stop" | "budget"; hint?: string },
  tally: Record<string, number>,
): boolean {
  if (verdict.stop) {
    target.final = "stop";
  } else if (verdict.budget) {
    const seen = (tally[verdict.budget.key] = (tally[verdict.budget.key] ?? 0) + 1);
    if (seen < verdict.budget.tries) return false;
    target.final = "budget";
  } else {
    return false;
  }
  target.hint = verdict.hint;
  return true;
}

/** Exponential backoff with jitter. retryAfterMs is a floor from the server. */
export function computeBackoffMs(attempt: number, retryAfterMs: number): number {
  // Exponential: 1s, 2s, 4s, 8s, 16s, capped; ±25% jitter prevents a thundering herd across processes
  const exponential = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), RETRY_MAX_DELAY_MS);
  const jittered = Math.round(exponential * (0.75 + Math.random() * 0.5));
  // WHY the floor is applied last and uncapped: capping Retry-After at 30 s and jittering it downward made a
  // "wait 60 s" reply retry after 22-37 s; a negative header value (Retry-After: -5) clamps to no floor.
  return Math.max(jittered, Math.max(0, retryAfterMs));
}


/** The `error.metadata.provider_name` of an OpenRouter error body, or undefined
 *  when the body is not that envelope. The retry trail reads the provider from
 *  here, the same field sanitizeProviderError renders as its `[Provider]`
 *  suffix, instead of regex-matching any bracket in the finished text (a
 *  message such as "bad item [0]" was read as the provider). */
export function providerNameFromBody(raw: string): string | undefined {
  return parseErrorBody(raw).providerName;
}

/**
 * Typed facts about one failed attempt (TRDD-YG72CYY7 inc 3), carried on the
 * thrown Error as a non-enumerable `failure` property. `final` and `hint` are
 * declared for the classifier of round B and are never set in round A.
 */
export interface FailureFields {
  status?: number;
  /** OpenRouter `error.code` of the body, stringified (it sends a number). */
  openrouterCode?: string;
  providerName?: string;
  /** `error.metadata.raw`, already sanitized and capped. */
  providerRaw?: string;
  retryAfterMs?: number;
  networkCode?: string;
  final?: "stop" | "budget";
  hint?: string;
  /** One-line OpenRouter provider-state text (inc 4), set only for a provider-side status on the primary OpenRouter host; read by the classifier, never by message/trail. */
  providerState?: string;
  /** The chain entry that produced this failure (profileChain, TRDD-5Q79QZM7 scope 3): lets a verdict group causes by model and provider (base URL) instead of merging them. */
  modelId?: string;
  baseUrl?: string;
}

export function attachFailure(err: Error, fields: FailureFields): void {
  // Non-enumerable so message, name, Object.keys and JSON.stringify stay byte-identical; configurable+writable because a later layer may re-attach newer fields, and a second plain defineProperty would throw inside error handling and replace the real error.
  Object.defineProperty(err, "failure", { value: fields, enumerable: false, configurable: true, writable: true });
}

/** The fields attached to `err`, or to a RetryDeadlineError's cause. */
export function failureOf(err: unknown): FailureFields | undefined {
  const source = err instanceof RetryDeadlineError ? err.cause : err;
  if (typeof source !== "object" || source === null) return undefined;
  return (source as { failure?: FailureFields }).failure;
}

/** The code/message/provider fields of an OpenRouter error envelope. A malformed or non-JSON body gives empty fields; never throws. */
export function parseErrorBody(raw: string): {
  code?: string;
  message?: string;
  providerName?: string;
  providerRaw?: string;
} {
  let envelope: unknown;
  try {
    envelope = (JSON.parse(raw) as { error?: unknown } | null)?.error;
  } catch {
    return {};
  }
  if (typeof envelope !== "object" || envelope === null) return {};
  const { code, message, metadata } = envelope as { code?: unknown; message?: unknown; metadata?: unknown };
  const meta = typeof metadata === "object" && metadata !== null
    ? (metadata as { provider_name?: unknown; raw?: unknown })
    : {};
  const providerName = typeof meta.provider_name === "string" && meta.provider_name.trim()
    ? meta.provider_name.trim()
    : undefined;
  const rawDetail = meta.raw === undefined || meta.raw === null
    ? undefined
    : typeof meta.raw === "string" ? meta.raw : JSON.stringify(meta.raw);
  return {
    code: typeof code === "number" || typeof code === "string" ? String(code) : undefined,
    message: typeof message === "string" ? message : undefined,
    providerName,
    // Sanitized here so an unsanitized upstream body (account ids, keys) is never stored.
    providerRaw: rawDetail ? sanitizeProviderError(rawDetail) : undefined,
  };
}

/** Retry-After as milliseconds (seconds or HTTP-date), undefined when absent or unparseable. */
export function retryAfterMsOf(headers: Headers): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;
  const parsed = Number(retryAfter);
  if (Number.isFinite(parsed)) return parsed * 1000;
  const dateMs = Date.parse(retryAfter);
  return isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

/** The failure fields of a non-ok HTTP response whose body text is `text`, plus the verdict fetchWithRetry429 registered for this Response. */
export function httpFailureFields(res: Response, text: string): FailureFields {
  const body = parseErrorBody(text);
  const verdict = RESPONSE_VERDICTS.get(res);
  return {
    status: res.status,
    openrouterCode: body.code,
    providerName: body.providerName,
    providerRaw: body.providerRaw,
    retryAfterMs: retryAfterMsOf(res.headers),
    final: verdict?.final,
    hint: verdict?.hint,
  };
}

const NETWORK_CODE_MAX_DEPTH = 5;

/**
 * The system error code behind a failed fetch. undici wraps it as
 * `TypeError: fetch failed` with the code on `.cause`; node's happy-eyeballs
 * connect failure is an AggregateError whose members hold the codes, so `.errors`
 * is read before `.code`. The request's own timeout abort is "ETIMEDOUT-LOCAL".
 *
 * Mixed AggregateError (D6): an IPv6-less localhost gives [ENETUNREACH,
 * ECONNREFUSED], which is still "nothing listening", so any refusal wins; on the
 * OpenRouter host only a unanimous refusal does (a multi-address remote with one
 * refusing address is not a dead service).
 */
export function networkCodeOf(err: unknown, url: string): string | undefined {
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return "ETIMEDOUT-LOCAL";
  }
  return walkNetworkCode(err, 0, isOpenRouterHost(hostOf(url)));
}

export function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).hostname : "";
}

// D5: the rule reads the request URL host only; a proxy base URL in front of OpenRouter gets the short DNS budget.
export function isOpenRouterHost(host: string): boolean {
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}

function walkNetworkCode(err: unknown, depth: number, openrouterHost: boolean): string | undefined {
  if (depth > NETWORK_CODE_MAX_DEPTH || typeof err !== "object" || err === null) return undefined;
  const { code, cause, errors } = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (Array.isArray(errors)) {
    const codes = errors
      .map((member) => walkNetworkCode(member, depth + 1, openrouterHost))
      .filter((c): c is string => c !== undefined);
    const refused = codes.filter((c) => c === "ECONNREFUSED").length;
    if (refused > 0 && (!openrouterHost || refused === errors.length)) return "ECONNREFUSED";
    const other = codes.find((c) => c !== "ECONNREFUSED");
    if (other !== undefined) return other;
    if (refused > 0) return "ECONNREFUSED";
  }
  if (typeof code === "string") return code;
  return walkNetworkCode(cause, depth + 1, openrouterHost);
}


/** Verdict stamped on the Response fetchWithRetry429 returns after stopping on it; read by httpFailureFields at the throw site, where only the Response is at hand. */
// WHY the exact object: the verdict rides on the Response fetchWithRetry429 returns, so a caller that clones or re-wraps it before building its Error loses the verdict.
const RESPONSE_VERDICTS = new WeakMap<Response, { final: "stop" | "budget"; hint?: string }>();

/** What classifyFailure decided for one failed attempt. */
export interface FailureVerdict {
  /** Stop at once, no further attempt. */
  stop?: boolean;
  /** Stop once `tries` failures of this `key` were seen (the caller counts). */
  budget?: { key: string; tries: number };
  hint?: string;
  /** The request never left the machine (name lookup), so it cannot have billed. */
  neverSent?: boolean;
}

const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export const GATEWAY_TIMEOUT_TRIES = 3;
export const REFUSED_TRIES = 2;
const NAME_LOOKUP_TRIES = 2;

/**
 * The first-failure verdict (TRDD-YG72CYY7 inc 3), pure and synchronous: it reads the
 * fields only. No verdict stamp for 401, 402, 403, 404 or 410 (their own handlers decide;
 * the same-model stop for them lives in the 4xx gate of completion.ts, owner ruling
 * 2026-10-23); everything not listed here retries as before.
 */
export function classifyFailure(f: FailureFields, host: string): FailureVerdict {
  if (f.status === 504) {
    return {
      budget: { key: "504", tries: GATEWAY_TIMEOUT_TRIES },
      hint: "the prompt is probably too large or too slow for this model; shorten the input or pick a faster model",
    };
  }
  const code = f.networkCode;
  if (code === undefined) return {};
  if (code === "ECONNREFUSED") {
    const where = host === "" ? "the configured endpoint" : host;
    return {
      budget: { key: "ECONNREFUSED", tries: REFUSED_TRIES },
      // The runner question only fits a local or custom endpoint, not the OpenRouter service.
      hint: `nothing is listening at ${where}` + (isOpenRouterHost(host) ? "" : "; is the local runner started?"),
    };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    // A DNS failure cannot bill (neverSent) and may heal within the window only for the real service.
    if (isOpenRouterHost(host)) return { neverSent: true };
    return { budget: { key: "dns", tries: NAME_LOOKUP_TRIES }, hint: `the host name ${host} cannot be resolved; check the base URL` };
  }
  if (TLS_CODES.has(code) || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL")) {
    return { stop: true, hint: `TLS certificate error (${code}); retrying cannot help` };
  }
  return {};
}


/**
 * Whether a failed attempt uses up one of RETRY_MAX_ATTEMPTS. A name-lookup failure on the OpenRouter host
 * (neverSent) gives its attempt back ONLY when a clock bounds the call: with no clock nothing else ends a
 * run of lookup failures except the attempt cap, so it must keep counting (chatCompletionJSON may have no clock).
 */
export function consumesAttempt(verdict: FailureVerdict, clock: RetryClock | undefined): boolean {
  return !(verdict.neverSent === true && clock !== undefined);
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
      // OpenRouter metadata object: it echoes account ids beside "error", and the raw-body fallback
      // below renders a truncated or message-less body verbatim, so the object is removed with its value.
      // shortcut: matches the object up to two brace levels, deeper nesting leaves later keys in the output, upgrade to a JSON parse when a real P-01 body nests deeper
      .replace(/"?openrouter_metadata"?\s*[:=]\s*(?:\{(?:[^{}]|\{[^{}]*\})*\}|"(?:[^"\\]|\\.)*"|[^,}\]\s]+)/gi, "")
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
    const provider = providerNameFromBody(raw) ?? "";
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
