/**
 * Shared response gate (TRDD-P4ULUV1R) — the non-empty + non-echo verdict a
 * surface applies before accepting a model's text as its result.
 *
 * Extracted from session_summary/driver.ts, which re-exports `isEchoResponse`
 * and keeps its stricter, schema-aware third verdict ("nonconforming") and the
 * `(nonconforming)` exit token untouched — ai-maestro-janitor 3.3.16 keys on
 * that literal, so that vocabulary must never leak into this generic layer.
 */

/** Below this many normalized characters, a substring match is not worth
 *  rejecting on — short generic replies ("Done.", "OK, summarized.") can
 *  coincide with a short fragment of the input by chance, and rejecting
 *  those would punish genuinely terse (but real) answers. Real echoes
 *  measured in the wild (a copied transcript line) run into the hundreds of
 *  characters, so this floor is far below any real echo and only guards
 *  against short-string false positives. */
export const ECHO_MIN_RESPONSE_LENGTH = 40;

export function normalizeForEchoCheck(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * True when `response` is not an answer about `sourceText` but a copy of it —
 * the WHOLE (normalized) response appears verbatim as a contiguous
 * substring of the source. Deliberately a "whole-response-is-input" test,
 * not "contains any input text": a legitimate answer very often quotes a
 * short fragment of the source (a file name, an error message, a command)
 * without being an echo, and rejecting on any shared substring would punish
 * that. Only when the ENTIRE response reduces to something already present
 * verbatim in the source — i.e. the model produced no new prose of its own
 * — is this a rejection. Measured live: a 1M-context free model asked to
 * summarize a large chunk returned a single raw line lifted straight from
 * the transcript; that response IS its own source substring in full.
 */
export function isEchoResponse(response: string, sourceText: string): boolean {
  const normResponse = normalizeForEchoCheck(response);
  if (normResponse.length < ECHO_MIN_RESPONSE_LENGTH) return false;
  const normSource = normalizeForEchoCheck(sourceText);
  return normSource.includes(normResponse);
}

/** `null` = the response is acceptable; otherwise the reason it is not. */
export type ResponseGateVerdict = null | "empty" | "echo";

/**
 * The default acceptance contract for a model response: non-empty and not a
 * verbatim echo of what we sent. `sourceText` is the surface's own user
 * payload (prompt + inlined file content) — the ground truth the echo check
 * judges against. Surfaces with a stricter contract (session_summary's
 * mandated-schema check) layer it on top; surfaces whose output is
 * structure-validated anyway (JSON-parsed paths) get conformance from the
 * parse and only need this for the text they accept as-is.
 */
export function gateLLMResponse(
  content: string,
  sourceText: string,
): ResponseGateVerdict {
  if (content.trim().length === 0) return "empty";
  if (isEchoResponse(content, sourceText)) return "echo";
  return null;
}

/** One user-facing sentence per verdict, shared so every surface reports the
 *  same failure the same way. */
export function gateFailureMessage(verdict: "empty" | "echo"): string {
  return verdict === "empty"
    ? "LLM returned empty response"
    : "LLM echoed its input back instead of answering";
}
