// Cost-safety guard (TRDD-e82f2c49). Pure, offline, free. Asserts the DEFAULT
// test backend can never bill OpenRouter — if a future change reverts
// resolveTestConfig() to the real/remote backend, THIS test fails (for free)
// instead of the user's balance.

import { describe, it, expect } from "vitest";
import { resolveTestConfig } from "./test-helpers";

describe("test cost-safety guard (TRDD-e82f2c49)", () => {
  it("default resolveTestConfig() is a LOCAL, unreachable backend that never bills", () => {
    const cfg = resolveTestConfig({ testName: "guard" });
    // Not the user's real/live backend.
    expect(cfg.liveBackend).toBe(false);
    // Local mode → the server never contacts openrouter.ai.
    expect(cfg.resolved.mode).toBe("local");
    expect(cfg.resolved.url).not.toMatch(/openrouter/i);
    // A guaranteed-dead local address → calls fail fast, free.
    expect(cfg.resolved.url.startsWith("http://127.0.0.1")).toBe(true);
    // Not an ensemble (no second/third model fan-out).
    expect(cfg.resolved.secondModel).toBe("");
    expect(cfg.resolved.thirdModel).toBe("");
  });

  it("requireLiveBackend:true selects the real backend, never a silent local fallback", () => {
    // Reads the real settings.yaml (file read only — no network, no spend).
    let live;
    try {
      live = resolveTestConfig({ testName: "guard-live", requireLiveBackend: true });
    } catch {
      // No resolvable live backend in this environment (e.g. CI with no API
      // key) → resolveTestConfig THROWS. That is the fail-fast contract: the
      // critical cost-safety invariant is asserted by the first test (default =
      // local, never bills); what must NEVER happen is requireLiveBackend:true
      // silently degrading to the free synthetic local backend and masking a
      // misconfiguration. The throw proves it did NOT degrade.
      return;
    }
    // When a live backend IS configured, it must be flagged live AND must be the
    // real backend — not the synthetic 127.0.0.1 unreachable one.
    expect(live.liveBackend).toBe(true);
    expect(live.resolved.url).not.toMatch(/127\.0\.0\.1/);
  });
});
