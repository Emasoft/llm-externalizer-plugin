/**
 * Unit tests for the high_quality_scan prompt-cache wire transform
 * (TRDD-DBUSM55E). high_quality_scan attaches an OpenRouter cache_control
 * breakpoint to the STABLE system prompt so the repeated per-file scan prefix is
 * cached across a folder's files. withSystemCacheBreakpoint is the pure transform
 * that does it; the main request path uses globalThis.fetch and cannot be unit-
 * driven (see model-events-emission.test.ts), so the wire-shape correctness is
 * proven here on the transform, the dispatch gate + provider block are unit-
 * tested in config.test.ts, and the fail-fast path is integration-tested in
 * index.test.ts.
 */

import { describe, it, expect } from "vitest";

// withSystemCacheBreakpoint moved to the completion layer (B1 Phase 5b,
// TRDD-63314265) — it is the prompt-cache transform chatCompletionSimple applies.
import { withSystemCacheBreakpoint } from "./provider/completion.js";

describe("withSystemCacheBreakpoint (prompt cache breakpoint, TRDD-DBUSM55E)", () => {
  it("wraps the system message in array-of-parts with an ephemeral cache_control", () => {
    const out = withSystemCacheBreakpoint([
      { role: "system", content: "You are a reviewer." },
      { role: "user", content: "code here" },
    ]);
    expect(out[0]).toEqual({
      role: "system",
      content: [
        {
          type: "text",
          text: "You are a reviewer.",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  });

  it("passes non-system messages through untouched (same reference)", () => {
    const user = { role: "user" as const, content: "code here" };
    const out = withSystemCacheBreakpoint([
      { role: "system", content: "sys" },
      user,
    ]);
    // The user message — which carries the per-file code and is NOT cacheable —
    // is returned by reference, unchanged.
    expect(out[1]).toBe(user);
  });

  it("only caches the system prefix, never the user code block", () => {
    const out = withSystemCacheBreakpoint([
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
    ]) as Array<{ content: unknown }>;
    expect(typeof out[1].content).toBe("string");
  });

  it("returns a new array and does not mutate the input", () => {
    const input = [{ role: "system" as const, content: "sys" }];
    const out = withSystemCacheBreakpoint(input);
    expect(out).not.toBe(input);
    // The original message object is left intact (still a plain string content).
    expect(input[0]).toEqual({ role: "system", content: "sys" });
  });

  it("is a no-op shape for a message whose content is not a string", () => {
    // Defensive: a pre-shaped array-content system message is passed through as-is
    // rather than double-wrapped.
    const preshaped = {
      role: "system" as const,
      content: [{ type: "text", text: "x" }] as unknown as string,
    };
    const out = withSystemCacheBreakpoint([preshaped]);
    expect(out[0]).toBe(preshaped);
  });
});
