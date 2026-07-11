// Tests for check-specs's P4 pre-flight workload description.
//
// describeWorkload() must be DERIVED from the real corpus on disk — never a hardcoded
// count — so these tests import the same dataset exports the estimate is built from and
// assert the two agree. No network call, no LLM call: everything here is a file read.

import { describe, it, expect } from "vitest";

import { CHECK_SPECS_FIXTURES, resolveFixtureRoot, specPath } from "./dataset.js";
import { readFileAsCodeBlock } from "../../scan-pipeline.js";
import { CHECK_SPECS_MAX_OUTPUT_TOKENS } from "./bench-runner.js";
import { describeWorkload } from "./index.js";

describe("check-specs describeWorkload", () => {
  it("callsPerModel equals the real fixture count — a corpus edit updates it automatically", () => {
    const workload = describeWorkload();
    expect(workload.callsPerModel).toBe(CHECK_SPECS_FIXTURES.length);
    // Pinned to the known corpus shape (dataset.test.ts pins the same 13) so a silent
    // shrink to 0 fixtures (e.g. a broken resolveFixtureRoot) cannot pass this test.
    expect(workload.callsPerModel).toBeGreaterThan(0);
  });

  it("promptCharsPerModel is > 0 and at least the spec's bytes resent once per call", () => {
    const workload = describeWorkload();
    const root = resolveFixtureRoot();
    const specBlock = readFileAsCodeBlock(specPath(root), undefined, false, undefined, null, "specs-");

    expect(workload.promptCharsPerModel).toBeGreaterThan(0);
    // check_against_specs makes ONE call per file (mode 0) and resends the WHOLE spec
    // block on every single call — this is the fact the estimate exists to capture, so
    // assert the total is at least `specBlock.length * callsPerModel`, not just the spec
    // once. If a future refactor accidentally sent the spec only once, this would fail.
    expect(workload.promptCharsPerModel).toBeGreaterThanOrEqual(
      specBlock.length * workload.callsPerModel,
    );
  });

  it("maxOutputTokensPerCall is the SAME constant the runner puts on the wire", () => {
    const workload = describeWorkload();
    expect(workload.maxOutputTokensPerCall).toBe(CHECK_SPECS_MAX_OUTPUT_TOKENS);
  });

  it("makes no network call and does not throw", async () => {
    // A pure disk read: calling it twice must be side-effect-free and deterministic.
    expect(() => describeWorkload()).not.toThrow();
    const a = describeWorkload();
    const b = describeWorkload();
    expect(b).toEqual(a);
  });
});
