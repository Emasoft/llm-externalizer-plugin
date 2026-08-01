// Unit tests for retry_ladder.ts (T17 in TRDD-220ea89f). Mock LLM call
// is a counter-driven closure that fails the first N calls then
// succeeds. Verifies every depth level fires, the 45-call hard cap
// holds, budget exhaustion records cleanly, and items below batch_size=2
// give up immediately.

import { describe, it, expect } from "vitest";
import {
  processBatchWithRetry,
  DEFAULT_RETRY_OPTIONS,
  type LlmCallFn,
  type RetryBudget,
} from "./retry_ladder.js";

const okValidate = (): { ok: true } => ({ ok: true });

function withRemaining(n: number): RetryBudget {
  return { remaining: n };
}

describe("retry_ladder", () => {
  it("single success on first attempt", async () => {
    const items = ["a", "b", "c"];
    const budget = withRemaining(100);
    let calls = 0;
    const llm: LlmCallFn<string, string> = async () => {
      calls += 1;
      return "ok";
    };
    const r = await processBatchWithRetry(items, llm, okValidate, DEFAULT_RETRY_OPTIONS, budget);
    expect(r.succeeded).toHaveLength(1);
    expect(r.succeeded[0].items).toEqual(items);
    expect(r.succeeded[0].depth).toBe(0);
    expect(r.succeeded[0].attempts).toBe(1);
    expect(r.failed).toEqual([]);
    expect(r.llmCallCount).toBe(1);
    expect(calls).toBe(1);
    expect(budget.remaining).toBe(99);
  });

  it("success after one retry", async () => {
    let calls = 0;
    const llm: LlmCallFn<string, string> = async () => {
      calls += 1;
      if (calls < 2) throw new Error("transient");
      return "ok";
    };
    const r = await processBatchWithRetry(
      ["a", "b"],
      llm,
      okValidate,
      DEFAULT_RETRY_OPTIONS,
      withRemaining(100),
    );
    expect(r.succeeded).toHaveLength(1);
    expect(r.failed).toEqual([]);
    expect(r.llmCallCount).toBe(2);
  });

  it("splits to depth 1 (2 sub-batches) on 3 retry exhaustion at depth 0, then succeeds at depth 1", async () => {
    // First 3 calls (depth 0) fail; subsequent calls (depth 1) succeed.
    let calls = 0;
    const llm: LlmCallFn<string, string> = async (_items, depth) => {
      calls += 1;
      if (depth === 0) throw new Error("depth0 always fails");
      return "ok";
    };
    const r = await processBatchWithRetry(
      ["a", "b", "c", "d"],
      llm,
      okValidate,
      DEFAULT_RETRY_OPTIONS,
      withRemaining(100),
    );
    expect(r.succeeded).toHaveLength(2); // 2 sub-batches at depth 1
    expect(r.succeeded.map((s) => s.depth)).toEqual([1, 1]);
    expect(r.succeeded.map((s) => s.items)).toEqual([["a", "b"], ["c", "d"]]);
    expect(r.failed).toEqual([]);
    // depth-0: 3 calls + depth-1: 1 call × 2 sub-batches = 5
    expect(r.llmCallCount).toBe(5);
    expect(calls).toBe(5);
  });

  it("splits to depth 2 (4 sub-batches) on depth-0 AND depth-1 failures", async () => {
    const llm: LlmCallFn<string, string> = async (_items, depth) => {
      if (depth < 2) throw new Error(`depth ${depth} always fails`);
      return "ok";
    };
    const r = await processBatchWithRetry(
      ["a", "b", "c", "d", "e", "f", "g", "h"],
      llm,
      okValidate,
      DEFAULT_RETRY_OPTIONS,
      withRemaining(200),
    );
    expect(r.succeeded).toHaveLength(4);
    expect(r.succeeded.every((s) => s.depth === 2)).toBe(true);
    expect(r.failed).toEqual([]);
    // depth-0: 3 + depth-1: 3*2 = 6 + depth-2: 1*4 = 4 → 13 total
    expect(r.llmCallCount).toBe(13);
  });

  it("splits to depth 3 (8 sub-batches) when all upper depths fail", async () => {
    const llm: LlmCallFn<string, string> = async (_items, depth) => {
      if (depth < 3) throw new Error(`depth ${depth} always fails`);
      return "ok";
    };
    const items = "abcdefgh".split(""); // 8 items
    const r = await processBatchWithRetry(
      items,
      llm,
      okValidate,
      DEFAULT_RETRY_OPTIONS,
      withRemaining(200),
    );
    expect(r.succeeded).toHaveLength(8);
    expect(r.succeeded.every((s) => s.depth === 3)).toBe(true);
    expect(r.failed).toEqual([]);
    // depth-0: 3 + depth-1: 3*2 = 6 + depth-2: 3*4 = 12 + depth-3: 1*8 = 8 → 29 total
    expect(r.llmCallCount).toBe(29);
  });

  it("HARD CAP — 45 LLM calls per source batch when every depth fails completely", async () => {
    // All depths fail; depth-3 leaves give up. Total = 3+6+12+24 = 45.
    let calls = 0;
    const llm: LlmCallFn<string, string> = async () => {
      calls += 1;
      throw new Error("everything fails");
    };
    const items = "abcdefgh".split("");
    const r = await processBatchWithRetry(items, llm, okValidate, DEFAULT_RETRY_OPTIONS, withRemaining(1000));
    expect(r.succeeded).toEqual([]);
    expect(r.failed).toHaveLength(8); // 8 leaf sub-batches at depth 3
    expect(r.failed.every((f) => f.depth === 3)).toBe(true);
    expect(r.failed.every((f) => f.attempts === 3)).toBe(true);
    expect(r.failed.every((f) => f.lastError === "everything fails")).toBe(true);
    expect(r.llmCallCount).toBe(45);
    expect(calls).toBe(45);
  });

  it("single-item batch gives up at depth 0 without splitting (can't bisect 1 item)", async () => {
    let calls = 0;
    const llm: LlmCallFn<string, string> = async () => {
      calls += 1;
      throw new Error("nope");
    };
    const r = await processBatchWithRetry(
      ["only-one"],
      llm,
      okValidate,
      DEFAULT_RETRY_OPTIONS,
      withRemaining(100),
    );
    expect(r.succeeded).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].items).toEqual(["only-one"]);
    expect(r.failed[0].depth).toBe(0);
    expect(r.failed[0].attempts).toBe(3);
    expect(r.llmCallCount).toBe(3);
    expect(calls).toBe(3);
  });

  it("validation failure counts as failed attempt (not exception)", async () => {
    let calls = 0;
    const llm: LlmCallFn<string, string> = async () => {
      calls += 1;
      return "garbage";
    };
    let validateCalls = 0;
    const validate = () => {
      validateCalls += 1;
      return { ok: false as const, reason: "schema mismatch" };
    };
    const r = await processBatchWithRetry(
      ["a"],
      llm,
      validate,
      DEFAULT_RETRY_OPTIONS,
      withRemaining(100),
    );
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].lastError).toBe("schema mismatch");
    expect(validateCalls).toBe(3);
    expect(calls).toBe(3);
  });

  it("budget exhaustion: pre-allocates calls, runs until 0, records remaining as 'budget exhausted'", async () => {
    const llm: LlmCallFn<string, string> = async () => {
      throw new Error("force split");
    };
    // budget = 5: enough for 3 depth-0 + first depth-1 attempt + one more attempt, then exhausts.
    const budget = withRemaining(5);
    const r = await processBatchWithRetry(
      ["a", "b", "c", "d"],
      llm,
      okValidate,
      DEFAULT_RETRY_OPTIONS,
      budget,
    );
    expect(r.budgetExhausted).toBe(true);
    expect(r.llmCallCount).toBe(5);
    expect(budget.remaining).toBe(0);
    // At least one failed entry mentions budget exhaustion.
    expect(r.failed.some((f) => f.lastError.includes("budget exhausted"))).toBe(true);
  });

  it("budget = 0 from the start: no LLM calls, items recorded with budget-exhausted reason", async () => {
    let calls = 0;
    const llm: LlmCallFn<string, string> = async () => {
      calls += 1;
      return "ok";
    };
    const budget = withRemaining(0);
    const r = await processBatchWithRetry(
      ["a", "b"],
      llm,
      okValidate,
      DEFAULT_RETRY_OPTIONS,
      budget,
    );
    expect(calls).toBe(0);
    expect(r.llmCallCount).toBe(0);
    expect(r.budgetExhausted).toBe(true);
    expect(r.succeeded).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].lastError).toBe("budget exhausted before attempt");
  });

  it("does NOT split when depth==maxSplitDepth even on failure", async () => {
    let calls = 0;
    const llm: LlmCallFn<string, string> = async () => {
      calls += 1;
      throw new Error("always fail");
    };
    // depth=0 IS maxSplitDepth=0 → no split allowed; one give-up entry.
    const r = await processBatchWithRetry(
      ["a", "b", "c", "d"],
      llm,
      okValidate,
      { maxRetriesPerAttempt: 3, maxSplitDepth: 0 },
      withRemaining(100),
    );
    expect(r.succeeded).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].depth).toBe(0);
    expect(r.failed[0].items).toEqual(["a", "b", "c", "d"]);
    expect(r.llmCallCount).toBe(3);
    expect(calls).toBe(3);
  });

  it("preserves items order across leaves (left half then right half)", async () => {
    // depth 0 fails, depth 1 succeeds.
    const llm: LlmCallFn<string, string> = async (_items, depth) => {
      if (depth === 0) throw new Error("split me");
      return "ok";
    };
    const items = ["a", "b", "c", "d", "e", "f"];
    const r = await processBatchWithRetry(items, llm, okValidate, DEFAULT_RETRY_OPTIONS, withRemaining(100));
    expect(r.succeeded).toHaveLength(2);
    // Floor(6/2) = 3. Left = a,b,c; right = d,e,f.
    expect(r.succeeded[0].items).toEqual(["a", "b", "c"]);
    expect(r.succeeded[1].items).toEqual(["d", "e", "f"]);
  });

  it("empty input items → no work, empty result", async () => {
    const llm: LlmCallFn<string, string> = async () => "ok";
    const r = await processBatchWithRetry([], llm, okValidate, DEFAULT_RETRY_OPTIONS, withRemaining(100));
    expect(r.succeeded).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.llmCallCount).toBe(0);
  });
});
