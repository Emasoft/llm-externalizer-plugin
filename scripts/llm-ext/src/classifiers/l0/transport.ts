// Plan §7: the transport seam returns a real Response because retry logic reads
// Retry-After / retry-after-ms headers; the header-less FetchImpl cannot carry them.
import { OPENROUTER_ATTRIBUTION_HEADERS, computeBackoffMs } from '../../provider/http.js';
import { safeReadText } from '../../safe-body.js';
import { type Deadline } from './deadline.js';
import { ClassifierError, badResponseError, classifyHttpError, networkError, timeoutError } from './errors.js';
import type { DecisionsEndpoint } from '../../config.js';

export type GlobalFetch = (url: string, init: RequestInit) => Promise<Response>;

// Plan §7 Body: the reply cap is 1,000,000 bytes.
export const MAX_REPLY_BYTES = 1_000_000;


// WHY re-exported: the union is defined in config.ts (Profile.endpoint), which must not import from classifiers/.
export type { DecisionsEndpoint };

// WHY a switch, not an object lookup: an object returns inherited members (e.g. "constructor") for an unknown name, which would reach fetch as a URL.
// WHY these URLs: the P-01 probe (reports/classifiers-probe/p01/probe.sh, URL_dec and URL_sys) sent every captured reply to exactly these.
function endpointUrl(endpoint: DecisionsEndpoint): string {
  switch (endpoint) {
    case 'decisions':
      return 'https://openrouter.ai/api/alpha/decisions';
    case 'systemone':
      return 'https://openrouter.ai/api/v1/systemone';
    default:
      // WHY refused here: a caller that skips the type (JavaScript, or data cast to it) must fail before anything is sent.
      throw new ClassifierError({ class: 'bad-request', message: `unknown endpoint "${String(endpoint)}"`, retryable: false });
  }
}

export interface DecisionsCall {
  endpoint: DecisionsEndpoint;
  model: string;
  state: unknown;
  questions: Record<string, unknown>;
  provider?: Record<string, unknown>;
  sessionId?: string;
  user?: string;
  trace?: Record<string, unknown>;
}

export interface RawDecisionsReply {
  model: string;
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number; cost?: number };
  id?: string;
  provider?: string;
}

export interface CallOptions {
  key: string;
  deadline: Deadline;
  /** Attempts per call, clamped to 1..6 by clampAttempts. */
  maxAttempts: number;
  fetchImpl: GlobalFetch;
  /** Parses the body of the winning 200 reply (default: JSON.parse, unchecked). A ClassifierError it throws reaches the caller as is. WHY here: the transport owns the text, so the body is parsed once (review C4-01 gap 1). */
  parseReply?: (text: string) => RawDecisionsReply;
}

const MAX_ATTEMPTS_CAP = 6;

/** max_attempts clamped to 1..6 (plan §7); NaN is a caller bug and is refused. */
export function clampAttempts(n: number): number {
  if (Number.isNaN(n)) throw new RangeError('maxAttempts must be a number, got NaN');
  return Math.min(MAX_ATTEMPTS_CAP, Math.max(1, Math.trunc(n)));
}

const HTTP_DATE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * The server's requested wait in ms: `retry-after-ms` (integer) wins, else `Retry-After` as integer seconds or HTTP-date.
 * WHY 0 for anything else: a garbage or past hint must fall back to our own backoff, never block or crash the retry (E03, E05).
 */
export function parseRetryAfter(headers: Headers, now: number): number {
  const ms = headers.get('retry-after-ms')?.trim();
  if (ms !== undefined && /^\d+$/.test(ms)) return Number(ms);
  const ra = headers.get('retry-after')?.trim();
  if (ra === undefined) return 0;
  if (/^\d+$/.test(ra)) return Number(ra) * 1000;
  // WHY the shape check: Date.parse is lenient and reads strings like "5 apples" as a date.
  if (HTTP_DATE.test(ra)) {
    const t = Date.parse(ra);
    if (!Number.isNaN(t)) return Math.max(0, t - now);
  }
  return 0;
}

// WHY the note: a reset connection or timeout gives no proof the server did not process the request, and a resend could be billed twice (D7, E09).
function maybeBilled(err: ClassifierError): ClassifierError {
  return new ClassifierError({ ...err, message: `${err.message} (the request may have been billed and was not retried)` });
}

type Attempt = { ok: true; reply: RawDecisionsReply } | { ok: false; error: ClassifierError; headers: Headers };

/** One send. HTTP failures are returned with their headers (the loop reads Retry-After); network, timeout and bad replies throw. */
async function sendOnce(call: DecisionsCall, body: string, opts: CallOptions): Promise<Attempt> {
  // WHY before the fetch try block: its catch below would relabel this refusal as a network error.
  const url = endpointUrl(call.endpoint);
  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      method: 'POST',
      // WHY redirect "error": the default follows a 3xx and would re-send the body to wherever it points;
      // the API never redirects, so a 3xx is a fault to report, not to follow (E08).
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${opts.key}`,
        'Content-Type': 'application/json',
        ...OPENROUTER_ATTRIBUTION_HEADERS,
      },
      body,
      signal: opts.deadline.signal,
    });
  } catch (e) {
    if (opts.deadline.reason === 'timeout') throw maybeBilled(timeoutError());
    opts.deadline.throwIfDone();
    throw maybeBilled(networkError(e));
  }
  let text: string;
  // WHY the body is read (drained) here, before the caller may wait: an unread body keeps the connection busy for the whole backoff.
  try {
    text = await safeReadText(res, MAX_REPLY_BYTES);
  } catch (e) {
    if (opts.deadline.reason === 'timeout') throw maybeBilled(timeoutError());
    opts.deadline.throwIfDone();
    // safeReadText has two cap messages (Content-Length "exceeds the", streamed "exceeded"); anything else is a broken connection.
    if (e instanceof Error && /exceed(s the|ed) \d+-byte cap/.test(e.message)) {
      throw badResponseError(`response body too large (cap ${MAX_REPLY_BYTES} bytes)`);
    }
    throw maybeBilled(networkError(e));
  }
  if (!res.ok) return { ok: false, error: classifyHttpError(res.status, res.headers, text), headers: res.headers };
  try {
    return { ok: true, reply: (opts.parseReply ?? ((t: string) => JSON.parse(t) as RawDecisionsReply))(text) };
  } catch (e) {
    // WHY only a SyntaxError (JSON.parse) is relabeled: a ClassifierError is the caller's parser's own classified refusal, and anything else is a programming error that must surface as one, not as a tidy "not valid JSON".
    if (e instanceof SyntaxError) throw badResponseError('reply is not valid JSON');
    throw e;
  }
}

/** Build the request and send it, retrying only errors classified retryable, inside the one deadline. Reply validation is L0-05. */
export async function callDecisions(call: DecisionsCall, opts: CallOptions): Promise<RawDecisionsReply> {
  if (opts.key === '') throw new ClassifierError({ class: 'auth', message: 'API key is empty', retryable: false });
  const body = JSON.stringify({
    model: call.model,
    state: call.state,
    questions: call.questions,
    provider: call.provider,
    session_id: call.sessionId,
    user: call.user,
    trace: call.trace,
  });
  // WHY refuse before sending: the state and questions come from user files and model output; a key inside them
  // would be uploaded to the provider and could end up in its logs. Exact-string match only (E14).
  if (body.includes(opts.key)) {
    throw new ClassifierError({
      class: 'bad-request',
      message: 'refused before sending: the API key text appears inside the state or questions',
      retryable: false,
    });
  }
  const max = clampAttempts(opts.maxAttempts);
  for (let attempt = 0; ; attempt++) {
    const r = await sendOnce(call, body, opts);
    if (r.ok) return r.reply;
    // WHY the verdict is ClassifierError.retryable (set once in classifyHttpError): retry only what can heal, throw the rest on the first failure with no wait.
    if (!r.error.retryable || attempt + 1 >= max) throw r.error;
    // WHY max(backoff, server hint) and not the 5 s cap of the old loop: the server knows when it will accept again (D7); computeBackoffMs adds the jitter.
    const wait = Math.max(computeBackoffMs(attempt, 0), parseRetryAfter(r.headers, Date.now()));
    const left = opts.deadline.remainingMs();
    // WHY fail now instead of sleeping into the deadline: a wait that cannot finish in time only delays the same failure (E04); the wait is reported so the caller can retry later.
    if (wait > left) {
      throw new ClassifierError({
        ...r.error,
        class: 'rate-limited',
        retryable: false,
        message: `${r.error.message}; retry wait of ${wait} ms exceeds the ${left} ms left before the deadline, not retried`,
      });
    }
    // WHY Deadline.sleep: an abort or the deadline must end the wait at once (E10).
    try {
      await opts.deadline.sleep(wait);
    } catch (e) {
      if (opts.deadline.reason === 'timeout') throw timeoutError();
      throw e;
    }
  }
}
