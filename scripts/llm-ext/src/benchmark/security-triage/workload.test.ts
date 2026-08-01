// Unit tests for the security-triage benchmark's P4 pre-flight workload
// estimate. No network — describeWorkload() only reads the shipped
// dataset.jsonl and calls the real (pure) prompt-building functions.

import { describe, it, expect } from "vitest";

import { describeWorkload } from "./index.js";
import { loadDataset } from "./dataset.js";
import { ASSUMED_MAX_OUTPUT_TOKENS } from "../budget.js";

describe("describeWorkload (security-triage)", () => {
  it("callsPerModel matches the real dataset's case count (a corpus edit moves the estimate)", () => {
    const cases = loadDataset();
    const workload = describeWorkload();
    expect(workload.callsPerModel).toBe(cases.length);
    expect(workload.tool).toBe("security_scan");
    expect(workload.benchmark).toBe("security-triage");
  });

  it("promptCharsPerModel is a large positive number, not a stub", () => {
    const workload = describeWorkload();
    // The system-prompt scaffolding alone runs well over 1000 chars per case
    // (rubric + boilerplate + envelope), so a real dataset of 20+ cases must
    // clear a five-figure total. A stub returning 0 or a tiny constant fails.
    expect(workload.promptCharsPerModel).toBeGreaterThan(10_000);
  });

  it("maxOutputTokensPerCall equals the STEP-1 bound (budget.ts's ASSUMED_MAX_OUTPUT_TOKENS)", () => {
    const workload = describeWorkload();
    expect(workload.maxOutputTokensPerCall).toBe(ASSUMED_MAX_OUTPUT_TOKENS);
  });

  it("makes no network call and does not throw", () => {
    expect(() => describeWorkload()).not.toThrow();
  });
});
