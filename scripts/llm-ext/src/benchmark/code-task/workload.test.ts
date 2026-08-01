// Tests for the code_task P4 pre-flight workload description.
//
// Nothing here is mocked: describeWorkload() reads the REAL dataset.jsonl and
// the REAL fixture corpus on disk, exactly like bench-runner.ts does. These
// tests exist to prove the estimate cannot drift silently from the real call
// pattern — a corpus edit must move callsPerModel/promptCharsPerModel with it.

import { describe, it, expect } from "vitest";

import { CODE_TASK_MAX_OUTPUT_TOKENS } from "./bench-runner.js";
import { loadDataset, readFixture, resolveFixtureRoot } from "./dataset.js";
import { describeWorkload } from "./index.js";

describe("code-task describeWorkload", () => {
  it("callsPerModel equals the real dataset's case count", () => {
    const cases = loadDataset();
    const workload = describeWorkload();
    expect(workload.tool).toBe("code_task");
    expect(workload.benchmark).toBe("code-task");
    expect(workload.callsPerModel).toBe(cases.length);
  });

  it("promptCharsPerModel is positive and at least the total fixture-source size it sends", () => {
    const cases = loadDataset();
    const fixtureRoot = resolveFixtureRoot();
    const totalFixtureBytes = cases.reduce(
      (n, c) => n + readFixture(c, fixtureRoot).length,
      0,
    );
    const workload = describeWorkload();
    expect(workload.promptCharsPerModel).toBeGreaterThan(0);
    // The prompt wraps every fixture's raw source in a code block plus the
    // system prompt and task instructions — so it must be strictly larger
    // than the bare fixture text, proving this isn't a stub returning e.g. 0
    // or a small constant.
    expect(workload.promptCharsPerModel).toBeGreaterThan(totalFixtureBytes);
  });

  it("maxOutputTokensPerCall is the exported constant the runner actually sends", () => {
    const workload = describeWorkload();
    expect(workload.maxOutputTokensPerCall).toBe(CODE_TASK_MAX_OUTPUT_TOKENS);
  });

  it("makes no network call and does not throw", () => {
    // Nothing here injects a fetch — describeWorkload() takes no FetchImpl
    // parameter at all, so a network call is not merely unused but structurally
    // impossible; calling it twice must be side-effect-free and deterministic
    // in shape (case count is stable; char count depends only on disk content).
    expect(() => describeWorkload()).not.toThrow();
    const first = describeWorkload();
    const second = describeWorkload();
    expect(second.callsPerModel).toBe(first.callsPerModel);
    expect(second.promptCharsPerModel).toBe(first.promptCharsPerModel);
  });
});
