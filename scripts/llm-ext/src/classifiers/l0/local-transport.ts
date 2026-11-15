/**
 * classifiers/l0/local-transport.ts — the LOCAL sender of the local decider fallback (mlx-decision increment 1):
 * one POST to the loopback decider, with the wire differences that make it a LOCAL call.
 *
 * Why a separate sender and not callDecisions with a different URL — every difference below is deliberate:
 * - the decider is on this machine and needs no credential, so the request carries NO Authorization, NO
 *   OPENROUTER_ATTRIBUTION_HEADERS, and NONE of the key guards of l0/transport.ts (the empty-key refusal
 *   and the key-in-body refusal): a key must never reach a loopback server that has no use for it, and a
 *   guard for a header we do not send would be dead code.
 * - the decider answers with its own failure vocabulary: a 422 names the required vs limit token counts in
 *   the server text (mapped EXPLICITLY, never by falling through to the generic status table), and a
 *   `X-MLX-Decision-Truncated: true` reply is a served-but-incomplete answer, not a retryable fault.
 * - WHAT IS SHARED, on purpose: the deadline/signal pattern and safeReadText, so an abort, a timeout and an
 *   oversized body behave exactly as they do for the remote sender.
 */

import { safeReadText } from "../../safe-body.js";
import type { Deadline } from "./deadline.js";
import { ClassifierError, classifyHttpError, networkError, timeoutError } from "./errors.js";
import { MAX_REPLY_BYTES, type GlobalFetch, type RawDecisionsReply } from "./transport.js";

/** The reply header the decider sets when the state did not fit its token budget. */
export const TRUNCATED_HEADER = "x-mlx-decision-truncated";

/** The local decisions call: the same fields the remote one sends, minus `endpoint` (the URL is the caller property here). */
export interface LocalDecisionsCall {
  model: string;
  state: unknown;
  questions: Record<string, unknown>;
  provider?: Record<string, unknown>;
  sessionId?: string;
  user?: string;
  trace?: Record<string, unknown>;
}

export interface LocalCallOptions {
  /** The decider base url, e.g. http://127.0.0.1:57455 (loopback only; checked by localFallbackErrors). */
  baseUrl: string;
  deadline: Deadline;
  fetchImpl: GlobalFetch;
  /** Parses the body of the winning 200 reply (default: JSON.parse). A ClassifierError it throws reaches the caller as is. */
  parseReply?: (text: string) => RawDecisionsReply;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The server text of a 422 body: its `error.message` (or `message`) when the body is JSON, else the body as
 * written. WHY this is read rather than left to classifyHttpError: the decider puts the REQUIRED vs LIMIT
 * token counts there, and that sentence is the only thing that tells the user how much state must be cut.
 */
function serverMessage(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown; message?: unknown };
    const errObj = isObject(parsed.error) ? parsed.error : undefined;
    const msg = typeof errObj?.message === "string" ? errObj.message : typeof parsed.message === "string" ? parsed.message : "";
    if (msg.trim() !== "") return msg.trim();
  } catch {
    /* not JSON: the raw body is the server text */
  }
  return bodyText.trim() === "" ? "(no response body)" : bodyText.trim();
}

/**
 * Send one local decisions request. Returns the parsed reply, or throws a ClassifierError: `bad-response`
 * for a truncated answer, `bad-request` for the decider 422, the generic classified error for every other
 * non-2xx, and `network`/`timeout` when nothing was served. Never retried here — the caller owns that.
 */
export async function callLocalDecisions(call: LocalDecisionsCall, opts: LocalCallOptions): Promise<{ reply: RawDecisionsReply }> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/v1/systemone`;
  const body = JSON.stringify({
    model: call.model,
    state: call.state,
    questions: call.questions,
    provider: call.provider,
    session_id: call.sessionId,
    user: call.user,
    trace: call.trace,
  });
  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      method: "POST",
      // WHY redirect "error": as for the remote sender, following a 3xx would re-send the state wherever it points.
      redirect: "error",
      // WHY ONLY this header: the local decider has no use for a credential or for attribution, and it strips
      // auth anyway; sending either would put the key on a loopback socket for nothing.
      headers: { "Content-Type": "application/json" },
      body,
      signal: opts.deadline.signal,
    });
  } catch (e) {
    if (opts.deadline.reason === "timeout") throw timeoutError();
    opts.deadline.throwIfDone();
    throw networkError(e);
  }
  let text: string;
  try {
    text = await safeReadText(res, MAX_REPLY_BYTES);
  } catch (e) {
    if (opts.deadline.reason === "timeout") throw timeoutError();
    opts.deadline.throwIfDone();
    throw networkError(e);
  }
  if (!res.ok) {
    // WHY before the generic mapping: a 422 is the decider telling us the state exceeded its token budget, so
    // the server text (required vs limit tokens) must survive verbatim — classifyHttpError would flatten it
    // to "API error 422: <sanitized body>" and lose the numbers the user has to act on.
    if (res.status === 422) {
      const message = serverMessage(text);
      throw new ClassifierError({ class: "bad-request", status: 422, message, reason: message, retryable: false });
    }
    throw classifyHttpError(res.status, res.headers, text);
  }
  // WHY the header and not the body: the decider reports the cut out of band, so a truncated state is refused
  // even when the answers it did produce parse cleanly — a partial answer would read as a complete one.
  if (res.headers.get(TRUNCATED_HEADER) === "true") {
    throw new ClassifierError({
      class: "bad-response",
      message: "the local decider truncated the state; the answer would be incomplete",
      retryable: false,
    });
  }
  try {
    return { reply: (opts.parseReply ?? ((t: string) => JSON.parse(t) as RawDecisionsReply))(text) };
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new ClassifierError({ class: "bad-response", message: "reply is not valid JSON", retryable: false });
    }
    throw e;
  }
}
