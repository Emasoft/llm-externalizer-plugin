// Error taxonomy for the decisions API (plan §7): one place turns a failed reply into a classified error,
// so retry-or-give-up is decided from the FIRST failure, without waiting.
import { sanitizeProviderError } from '../../provider/http.js';

export type ErrorClass =
  | 'auth'
  | 'payment'
  | 'in-flight-budget'
  | 'key-limit'
  | 'rate-limited'
  | 'unavailable'
  | 'context-overflow'
  | 'bad-request'
  | 'not-found'
  | 'too-large'
  | 'network'
  | 'timeout'
  | 'bad-response';

export interface ClassifierErrorFields {
  class: ErrorClass;
  message: string;
  /** HTTP status; absent only for network, timeout and bad-response failures that have no reply. */
  status?: number;
  limit_source?: string;
  reason?: string;
  provider_code?: string;
  remedy_hint?: string;
  retryable: boolean;
}

export class ClassifierError extends Error implements ClassifierErrorFields {
  readonly class: ErrorClass;
  readonly status?: number;
  readonly limit_source?: string;
  readonly reason?: string;
  readonly provider_code?: string;
  readonly remedy_hint?: string;
  readonly retryable: boolean;
  constructor(f: ClassifierErrorFields) {
    super(f.message);
    this.name = 'ClassifierError';
    this.class = f.class;
    this.status = f.status;
    this.limit_source = f.limit_source;
    this.reason = f.reason;
    this.provider_code = f.provider_code;
    this.remedy_hint = f.remedy_hint;
    this.retryable = f.retryable;
  }
}

/** Client-side failures with no reply. WHY never retryable: a resent request may be billed twice (D7). */
export function networkError(cause: unknown): ClassifierError {
  const reason = sanitizeProviderError(cause instanceof Error ? cause.message : String(cause));
  return new ClassifierError({ class: 'network', message: `network error: ${reason}`, reason, retryable: false });
}

export function timeoutError(): ClassifierError {
  return new ClassifierError({ class: 'timeout', message: 'deadline exceeded', reason: 'deadline exceeded', retryable: false });
}

/** 200 with an unusable body (§7 Response). Not retried: the call was served and billed. */
export function badResponseError(reason: string): ClassifierError {
  const r = sanitizeProviderError(reason);
  return new ClassifierError({ class: 'bad-response', message: `bad response: ${r}`, reason: r, retryable: false });
}

function bodyFields(bodyText: string): { code?: string; message: string } {
  try {
    const e = (JSON.parse(bodyText) as { error?: { code?: unknown; message?: unknown } }).error;
    const code = typeof e?.code === 'string' || typeof e?.code === 'number' ? String(e.code) : undefined;
    return { code, message: typeof e?.message === 'string' ? e.message : '' };
  } catch {
    return { message: '' }; // non-JSON body (e.g. "404 Not Found"): classify by status alone
  }
}

/**
 * Classify a non-2xx reply. The status is always kept in the message and the field (§7: jev-agent-tools
 * loses it, do not copy). Probe-measured, differing from the plan: an unknown model id is HTTP 400 (so the
 * body decides, not the status), max_tokens_exceeded is HTTP 400 with JSON inside the message string, and 413 only
 * appears above 52,428,800 bytes.
 */
export function classifyHttpError(status: number, headers: Headers, bodyText: string): ClassifierError {
  const { code, message } = bodyFields(bodyText);
  const reason = sanitizeProviderError(bodyText);
  const f: ClassifierErrorFields = {
    class: 'bad-request',
    status,
    message: `API error ${status}: ${reason}`,
    reason,
    provider_code: code,
    retryable: false,
  };
  const text = `${message} ${bodyText}`;
  if (status === 401) f.class = 'auth';
  else if (status === 402 || status === 403) {
    // WHY the exact marker: a 402 whose prose merely says "in flight" must not be retried (plan §7).
    if (status === 402 && /openrouter_in_flight_budget/.test(text)) {
      // WHY the 402 split: an in-flight budget frees itself as running calls finish, so it is the one 402
      // worth retrying; credits and key limits stay empty until a human acts, so retrying only wastes the deadline.
      f.class = 'in-flight-budget';
      f.limit_source = 'openrouter_in_flight_budget';
      f.retryable = true;
    } else if (/key.{0,20}limit|limit.{0,20}key|spending limit/i.test(text)) {
      f.class = 'key-limit';
      f.limit_source = 'key_limit';
      f.remedy_hint = 'Raise or remove the limit on this API key in the OpenRouter dashboard.';
    } else if (status === 402) {
      f.class = 'payment';
      f.limit_source = 'credits';
      f.remedy_hint = 'Add credits to the OpenRouter account.';
    } else f.class = 'auth';
  } else if (status === 404) f.class = 'not-found';
  else if (status === 413) f.class = 'too-large';
  else if (status === 429) {
    f.class = 'rate-limited';
    // WHY: a platform limit carries X-RateLimit-* headers, a provider limit does not; both are retried.
    f.limit_source = [...headers.keys()].some((k) => k.toLowerCase().startsWith('x-ratelimit-')) ? 'platform' : 'provider';
    f.retryable = true;
  } else if (status === 408 || status === 409 || (status >= 500 && status <= 599)) {
    f.class = 'unavailable';
    f.retryable = true;
  } else if (status === 400) {
    if (/max_tokens_exceeded/.test(text)) f.class = 'context-overflow';
    else if (/model\b.*\bdoes not exist/i.test(message)) f.class = 'not-found';
  }
  return new ClassifierError(f);
}
