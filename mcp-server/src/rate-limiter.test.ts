// Unit tests for rate-limiter.ts (B1 Phase 2 extraction, TRDD-63314265).
// The AIMD rate-state logic is deterministic (no time dependence); acquire()
// timing is exercised lightly. No network, no LLM.

import { describe, it, expect } from "vitest";
import { AdaptiveRateLimiter } from "./rate-limiter.js";

describe("AdaptiveRateLimiter", () => {
  it("starts at the requested RPS", () => {
    expect(new AdaptiveRateLimiter(8).rps).toBe(8);
  });

  it("floors the initial RPS at 1", () => {
    expect(new AdaptiveRateLimiter(0).rps).toBe(1);
    expect(new AdaptiveRateLimiter(-5).rps).toBe(1);
  });

  it("halves RPS on a rate-limit hit (multiplicative decrease)", () => {
    const rl = new AdaptiveRateLimiter(8);
    rl.onRateLimit();
    expect(rl.rps).toBe(4);
    rl.onRateLimit();
    expect(rl.rps).toBe(2);
  });

  it("never drops RPS below 1", () => {
    const rl = new AdaptiveRateLimiter(1);
    rl.onRateLimit();
    expect(rl.rps).toBe(1);
  });

  it("additively increases by 1 after 10 consecutive successes (when below initial)", () => {
    const rl = new AdaptiveRateLimiter(8);
    rl.onRateLimit(); // 8 → 4, resets success streak
    expect(rl.rps).toBe(4);
    for (let i = 0; i < 10; i++) rl.onSuccess();
    expect(rl.rps).toBe(5);
  });

  it("never increases RPS above the initial ceiling", () => {
    const rl = new AdaptiveRateLimiter(8);
    for (let i = 0; i < 50; i++) rl.onSuccess();
    expect(rl.rps).toBe(8);
  });

  it("a rate-limit hit resets the success streak (no premature increase)", () => {
    const rl = new AdaptiveRateLimiter(8);
    rl.onRateLimit(); // → 4
    for (let i = 0; i < 9; i++) rl.onSuccess(); // 9 successes, not yet 10
    rl.onRateLimit(); // → 2, streak reset
    for (let i = 0; i < 9; i++) rl.onSuccess(); // 9 again — still no bump
    expect(rl.rps).toBe(2);
  });

  it("reset() restores the initial RPS", () => {
    const rl = new AdaptiveRateLimiter(8);
    rl.onRateLimit();
    rl.onRateLimit();
    expect(rl.rps).toBe(2);
    rl.reset();
    expect(rl.rps).toBe(8);
  });

  it("reset(newInitial) adopts a new ceiling", () => {
    const rl = new AdaptiveRateLimiter(8);
    rl.reset(16);
    expect(rl.rps).toBe(16);
    for (let i = 0; i < 200; i++) rl.onSuccess();
    expect(rl.rps).toBe(16); // capped at the new ceiling
  });

  it("acquire() resolves and consumes a token when capacity is available", async () => {
    const rl = new AdaptiveRateLimiter(100);
    await expect(rl.acquire()).resolves.toBeUndefined();
  });
});
