/**
 * Unit tests for the review_plan delegate-mode plan builder (TRDD-SNAEERHU).
 * The builder is pure; dispatch-level file resolution is the estimator seam's
 * job and is covered by its own tests. Load-bearing here: the plan must say
 * the host agent reviews (delegate contract), must carry the rubric, must
 * append — never replace — caller instructions, and must throw on an empty
 * file list rather than emitting a plan that reviews nothing.
 */
import { describe, it, expect } from "vitest";
import { buildReviewPlan, DEFAULT_REVIEW_RUBRIC } from "./review-plan.js";

const files = [
  { path: "/repo/big.ts", bytes: 9000 },
  { path: "/repo/small.ts", bytes: 100 },
];

describe("buildReviewPlan", () => {
  it("carries the delegate contract, the rubric, and every file", () => {
    const plan = buildReviewPlan(files);
    expect(plan).toContain("no LLM was called");
    expect(plan).toContain("YOU (the host agent) are the reviewer");
    expect(plan).toContain(DEFAULT_REVIEW_RUBRIC);
    expect(plan).toContain("/repo/big.ts");
    expect(plan).toContain("/repo/small.ts");
  });

  it("lists files smallest-first so context-heavy work comes last", () => {
    const plan = buildReviewPlan(files);
    expect(plan.indexOf("/repo/small.ts")).toBeLessThan(plan.indexOf("/repo/big.ts"));
  });

  it("APPENDS caller instructions to the rubric instead of replacing it", () => {
    const plan = buildReviewPlan(files, { instructions: "focus on the ledger writes" });
    expect(plan).toContain(DEFAULT_REVIEW_RUBRIC);
    expect(plan).toContain("focus on the ledger writes");
    expect(plan).toContain("append to, do not replace");
  });

  it("names the report directory the caller passes", () => {
    const plan = buildReviewPlan(files, { reportDir: "/main/reports/llm-externalizer/" });
    expect(plan).toContain("/main/reports/llm-externalizer/");
  });

  it("THROWS on an empty file list — a plan that reviews nothing is a caller bug", () => {
    expect(() => buildReviewPlan([])).toThrow(/no files/);
  });
});
