// Benchmark fixture — real code with a KNOWN feature location (TRDD-828238b5 A6).
// Feature: HMAC-signed token creation and verification. The signing key is
// always a caller-supplied parameter — this fixture intentionally contains
// no credentials of any kind.

import { createHmac, timingSafeEqual } from "node:crypto";

function hmac(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** Create a signed token of the form `<base64url payload>.<signature>`. */
export function signToken(payload: Record<string, unknown>, key: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(body, key)}`;
}

/**
 * Verify a token's signature and return its payload, or null when the
 * signature does not match. Comparison is constant-time.
 */
export function verifyToken(
  token: string,
  key: string,
): Record<string, unknown> | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(body, key);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}
