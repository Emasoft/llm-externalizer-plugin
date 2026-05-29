// Provider-error sanitizer (TRDD-54f508a4, Issue 1).
// Pure, offline, free. Importing ./index is safe — the entry-point guard
// (TRDD-e82f2c49) stops it booting the server during tests.

import { describe, it, expect } from "vitest";
import { sanitizeProviderError } from "./index";

describe("sanitizeProviderError — privacy-safe provider error collapse (TRDD-54f508a4)", () => {
  // The exact live blob from the dogfood run that exposed the user_id leak.
  const REAL_429 = JSON.stringify({
    error: {
      message: "Provider returned error",
      code: 429,
      metadata: {
        raw: "google/gemma-4-26b-a4b-it:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations",
        provider_name: "Google AI Studio",
        is_byok: false,
      },
    },
    user_id: "user_2g2eD6sJXkPdZVmNmxorPcNPLBo",
  });

  it("strips the user_id account token (the privacy leak)", () => {
    const out = sanitizeProviderError(REAL_429);
    expect(out).not.toContain("user_2g2eD6sJXkPdZVmNmxorPcNPLBo");
    expect(out.toLowerCase()).not.toContain("user_id");
  });

  it("keeps the message, provider, and upstream detail", () => {
    const out = sanitizeProviderError(REAL_429);
    expect(out).toContain("Provider returned error");
    expect(out).toContain("Google AI Studio");
    expect(out).toContain("temporarily rate-limited upstream");
  });

  it("drops the JSON envelope (no braces / metadata noise)", () => {
    const out = sanitizeProviderError(REAL_429);
    expect(out).not.toContain('{"error"');
    expect(out).not.toContain('"metadata"');
    expect(out).not.toContain("is_byok");
  });

  it("preserves rate-limit wording so the classifier OR-fallback still matches", () => {
    // classifyError matches /API error 429\b/ (prefix added by the caller) OR
    // /rate.?limit/i. The sanitized 429 body still contains 'rate-limited',
    // so even if a future caller dropped the prefix the fallback holds.
    expect(/rate.?limit/i.test(sanitizeProviderError(REAL_429))).toBe(true);
  });

  it("handles the 'free-models-per-min' 429 shape (no metadata.raw)", () => {
    const blob = JSON.stringify({
      error: {
        message: "Rate limit exceeded: free-models-per-min. ",
        code: 429,
        metadata: { headers: { "X-RateLimit-Remaining": "0" } },
      },
      user_id: "user_abc123",
    });
    const out = sanitizeProviderError(blob);
    expect(out).toContain("Rate limit exceeded: free-models-per-min.");
    expect(out).not.toContain("user_abc123");
  });

  it("falls back to the scrubbed raw on a non-JSON body (HTML error page)", () => {
    const html = "<html><body>502 Bad Gateway</body></html>";
    expect(sanitizeProviderError(html)).toContain("502 Bad Gateway");
  });

  it("returns a placeholder for an empty / whitespace body", () => {
    expect(sanitizeProviderError("")).toBe("(no response body)");
    expect(sanitizeProviderError("   ")).toBe("(no response body)");
  });

  it("caps very long bodies and marks the truncation", () => {
    const longRaw = JSON.stringify({ error: { message: "x".repeat(500) } });
    const out = sanitizeProviderError(longRaw, 80);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
  });

  it("scrubs API-key-looking tokens even from a non-JSON body", () => {
    const out = sanitizeProviderError("auth failed for sk-or-v1-deadbeefdeadbeef0123");
    expect(out).not.toContain("sk-or-v1-deadbeefdeadbeef0123");
    expect(out).toContain("sk-***");
  });

  it("strips a bare user_id from an unparseable tail (belt & suspenders)", () => {
    const out = sanitizeProviderError('garbage "user_id":"user_LEAK999" trailing');
    expect(out).not.toContain("user_LEAK999");
  });
});
