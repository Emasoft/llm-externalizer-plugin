// Token estimate for a request payload, rounded up; the request planner uses it to keep a request under the model context limit.

/**
 * Char-class token estimate (E29), rounded up: letters 1/3 token, digits 1/2, whitespace 1/4,
 * other ASCII 1/1.5, each non-ASCII code point 1. Non-string values count as their JSON text.
 */
export function estimateTokens(v: unknown): number {
  // Why JSON: the model receives the serialized payload, not the JS value.
  const text = typeof v === "string" ? v : JSON.stringify(v);
  // Why throw: JSON.stringify returns undefined for undefined, functions and symbols; counting 0 would silently under-estimate the request.
  if (text === undefined) throw new TypeError(`estimateTokens: a ${typeof v} value has no JSON form`);
  // Why twelfths as integers: summing 1/3 and 1/1.5 in floats is inexact, so a whole total could land just above the integer and ceil would add a token.
  let twelfths = 0;
  // Why per-class rates: a flat 1/4 per ASCII char under-estimated code and JSON by 25-48%, letting an oversized request through to a non-retried HTTP 400.
  // Why for...of: it iterates code points, so an emoji (two UTF-16 units) counts once.
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (code > 0x7f) twelfths += 12;
    else if ((code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a)) twelfths += 4;
    else if (code >= 0x30 && code <= 0x39) twelfths += 6;
    else if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") twelfths += 3;
    else twelfths += 8;
  }
  return Math.ceil(twelfths / 12);
}
