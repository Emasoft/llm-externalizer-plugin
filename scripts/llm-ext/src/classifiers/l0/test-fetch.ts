import type { GlobalFetch } from "./transport.js";

/** A captured wire reply (P-01/P-02 fixture): status, headers and the raw body text. */
export interface RecordedReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Replay a captured fixture as a real Response (D21: tests use real recorded replies). */
export function replayFixture(rec: RecordedReply): Response {
  return new Response(rec.body, { status: rec.status, headers: rec.headers });
}

/**
 * Build a Response for a fault that cannot be produced on demand (HTML body, >1 MB body,
 * Retry-After variants; D21). Tests using it must be named `synthetic: …`.
 */
export function syntheticResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

export interface ReplayFetch {
  fetch: GlobalFetch;
  calls: { url: string; init: RequestInit }[];
}

/**
 * A GlobalFetch that serves the given replies in order and records every call.
 * Running out of replies throws: an unexpected extra request must fail the test (fail fast).
 */
export function replayFetch(replies: (Response | RecordedReply)[]): ReplayFetch {
  const calls: ReplayFetch["calls"] = [];
  const queue = [...replies];
  const fetch: GlobalFetch = async (url, init) => {
    calls.push({ url, init });
    // WHY: a real fetch rejects on an aborted signal, so the replay must too, and it must leave the queued reply in place.
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
    const next = queue.shift();
    if (next === undefined) throw new Error(`replayFetch: no reply left for call ${calls.length} (${url})`);
    return next instanceof Response ? next : replayFixture(next);
  };
  return { fetch, calls };
}
