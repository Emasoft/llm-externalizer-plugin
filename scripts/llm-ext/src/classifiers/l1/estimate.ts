// Token estimate for a request payload, rounded up; the request planner uses it to keep a request under the model context limit.

/**
 * Char-class token estimate (E29), rounded up: letters 1/3 token, digits 1/2, whitespace 1/4,
 * other ASCII 1/1.5, each non-ASCII code point 1. Non-string values count as their JSON text.
 * Exception (TRDD-4JLBB1YT): a random-looking run of 16+ chars of [A-Za-z0-9+/=-] costs 11/12 token per char (digits >= 40% of the run, or only [0-9a-fA-F-]: hex, UUID)
 * or 9/12 (mixed case with at least half of the adjacent pairs changing class: base64), which is what the decider measured on such text.
 */
export function estimateTokens(v: unknown): number {
  // Why JSON: the model receives the serialized payload, not the JS value.
  const text = typeof v === "string" ? v : JSON.stringify(v);
  // Why throw: JSON.stringify returns undefined for undefined, functions and symbols; counting 0 would silently under-estimate the request.
  if (text === undefined) throw new TypeError(`estimateTokens: a ${typeof v} value has no JSON form`);
  // Why twelfths as integers: summing 1/3 and 1/1.5 in floats is inexact, so a whole total could land just above the integer and ceil would add a token.
  let twelfths = 0;
  // Run state, counters only. Why a run: TRDD-4JLBB1YT, a maximal stretch of [A-Za-z0-9+/=-] is the unit in which random text (base64, hex, UUID) is tokenized far finer than the per-class rates assume.
  let runLen = 0;
  let runOld = 0;
  let runTransitions = 0;
  let runLastClass = -1;
  let runDigits = 0;
  let runUpper = false;
  let runLower = false;
  // Why hex-only: TRDD-4JLBB1YT, a run of [0-9a-fA-F-] (hex id, UUID) is random text whatever its digit share; true until a char outside that set.
  let runHexOnly = true;
  const flushRun = (): void => {
    if (runLen === 0) return;
    // Why these two tests (TRDD-4JLBB1YT, measured against the local decider, input_tokens minus its fixed overhead): the per-class rates counted random base64 at 0.50 of the decider count (decider/estimate 1.98 to 1.99 at 1000 to 12000 chars), UUID lists at 0.52 (1.94) and 32-char hex ids at 0.49 (2.06), so a request planned under the limit got HTTP 422. Code (0.76 to 0.92) and prose (0.70) were overcounted and must not move.
    // Why 11/12 when digits >= 40% OR the run is hex-only ([0-9a-fA-F-] with a digit and a letter): random hex is only about 62% digits, so a few ids per list fall under 40% (out-of-sample 3 of 109 UUIDs, 1 of 122 hex ids) and were counted at the per-class rate, about half the decider count; one list came out 19 tokens under the decider. In the measured code and prose (3 repo source files, 1 README excerpt) no run reached 39% digits and no run was hex-only; a case-and-digit transition ratio could not separate hex from camelCase (13 of 122 hex ids fall under 0.35, camelCase reaches 0.40). A digit-dense or hex-only id in other code (a literal such as deadbeefcafef00d) is counted at 11/12, an overcount, which only splits a request earlier. Why mixed case with transitions >= 1/2 for the 9/12 rate: random base64 changes class on 0.64 of its pairs, camelCase identifiers on 0.40 at most, and a threshold of 0.35 reclassified 10 identifiers in code. Why 16 chars and a letter: shorter runs and pure digit runs keep the per-class rates (not measured). Measured margin over the decider: the thinnest was 12 tokens (0.3%) on one 4000-char hex list; four hex and UUID lists near the 16384 limit (about 17,700 chars) came out at 0.987 to 0.989 of the estimate. The seeds, counts and margins are recorded on TRDD-4JLBB1YT.
    const dense = (runDigits * 5 >= runLen * 2) || (runHexOnly && runDigits > 0);
    const mixedRandom = runUpper && runLower && runTransitions * 2 >= runLen - 1;
    if (runLen >= 16 && (runUpper || runLower) && (dense || mixedRandom)) twelfths += runLen * (dense ? 11 : 9);
    else twelfths += runOld;
    runLen = 0;
    runOld = 0;
    runTransitions = 0;
    runLastClass = -1;
    runDigits = 0;
    runUpper = false;
    runLower = false;
    runHexOnly = true;
  };
  // Why per-class rates: a flat 1/4 per ASCII char under-estimated code and JSON by 25-48%, letting an oversized request through to a non-retried HTTP 400.
  // Why for...of: it iterates code points, so an emoji (two UTF-16 units) counts once.
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    const lower = code >= 0x61 && code <= 0x7a;
    const upper = code >= 0x41 && code <= 0x5a;
    const digit = code >= 0x30 && code <= 0x39;
    let rate: number;
    if (code > 0x7f) rate = 12;
    else if (lower || upper) rate = 4;
    else if (digit) rate = 6;
    else if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") rate = 3;
    else rate = 8;
    // Why underscore is not in the run: snake_case and constant names are code, not random text.
    if (lower || upper || digit || code === 0x2b || code === 0x2f || code === 0x3d || code === 0x2d) {
      const cls = lower ? 0 : upper ? 1 : digit ? 2 : 3;
      if (runLen > 0 && cls !== runLastClass) runTransitions++;
      runLastClass = cls;
      runLen++;
      runOld += rate;
      if (!(digit || (code >= 0x61 && code <= 0x66) || (code >= 0x41 && code <= 0x46) || code === 0x2d)) runHexOnly = false;
      if (digit) runDigits++;
      else if (lower) runLower = true;
      else if (upper) runUpper = true;
    } else {
      flushRun();
      twelfths += rate;
    }
  }
  flushRun();
  return Math.ceil(twelfths / 12);
}
