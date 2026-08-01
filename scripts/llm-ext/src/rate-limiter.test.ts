// Unit tests for rate-limiter.ts (B1 Phase 2 extraction, TRDD-63314265).
// The AIMD rate-state logic is deterministic (no time dependence); acquire()
// timing is exercised lightly. No network, no LLM.

import { describe, it, expect } from "vitest";
import {
  AdaptiveRateLimiter,
  rateLimitedParallel,
  signalRateLimitHit,
  signalSuccess,
} from "./rate-limiter.js";

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

describe("rateLimitedParallel (B1 Phase 2b extraction)", () => {
  it("returns an empty array for no tasks", async () => {
    expect(await rateLimitedParallel([], 10)).toEqual([]);
  });

  it("preserves result order regardless of completion order", async () => {
    // Task 0 is the SLOWEST (finishes last) yet results[0] must be its value —
    // proving results are keyed by original index, not completion order.
    const tasks: (() => Promise<number>)[] = [
      () => new Promise((r) => setTimeout(() => r(1), 15)),
      () => new Promise((r) => setTimeout(() => r(2), 1)),
      () => new Promise((r) => setTimeout(() => r(3), 8)),
    ];
    expect(await rateLimitedParallel(tasks, 100, 10)).toEqual([1, 2, 3]);
  });

  it("runs every task exactly once", async () => {
    let calls = 0;
    const tasks = Array.from({ length: 12 }, () => async () => {
      calls++;
      return calls;
    });
    const results = await rateLimitedParallel(tasks, 100, 5);
    expect(calls).toBe(12);
    expect(results).toHaveLength(12);
  });

  it("never exceeds maxInFlight concurrent tasks (but does run in parallel)", async () => {
    let active = 0;
    let maxActive = 0;
    const makeTask = () => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return 0;
    };
    const tasks = Array.from({ length: 20 }, makeTask);
    await rateLimitedParallel(tasks, 1000, 3); // high RPS so maxInFlight is the binding cap
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1); // genuinely concurrent, not serialized
  });

  it("reports progress, reaching the total on completion", async () => {
    const seen: number[] = [];
    const tasks = Array.from({ length: 4 }, () => async () => 0);
    await rateLimitedParallel(tasks, 100, 4, (done) => seen.push(done));
    expect(Math.max(...seen)).toBe(4);
  });

  it("signalRateLimitHit() and signalSuccess() never throw (guarded delegators)", () => {
    // They no-op until the shared singleton exists and delegate to it once it
    // does — either way they must never throw, preserving the old
    // `if (adaptiveRateLimiter)` guard that index.ts used to inline.
    expect(() => signalRateLimitHit()).not.toThrow();
    expect(() => signalSuccess()).not.toThrow();
  });
});
