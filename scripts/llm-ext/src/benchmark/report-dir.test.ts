// C9 write-roots sweep (2026-09-18): benchmarkSubReportDir() is the single
// helper every scan-folder/code-task/search-existing/security-triage/
// check-specs/text-tools benchmark now routes its DEFAULT report dir through
// (opts.outputDir still overrides it at every call site). Before this helper
// existed, each of the six files hand-rolled `join(mainRoot, "reports",
// "<sub>")` — landing at <project-root>/reports/<sub>/, OUTSIDE every
// USER-approved write root (write-roots rule, 2026-09-18). This test would
// have failed red against that old join() (it asserts "llm-externalizer" is
// on the path, which the old shape never had).
import { describe, it, expect } from "vitest";

import { benchmarkSubReportDir } from "./report-dir.js";

describe("benchmarkSubReportDir (C9 write-roots sweep)", () => {
  it("nests the sub-dir under <mainRoot>/reports/llm-externalizer/, not <mainRoot>/reports/ directly", () => {
    const dir = benchmarkSubReportDir("scan-folder-benchmark", "/tmp/fake-project-root");
    expect(dir).toBe("/tmp/fake-project-root/reports/llm-externalizer/scan-folder-benchmark");
  });

  it("uses a distinct sub-dir per caller-supplied name", () => {
    const dir = benchmarkSubReportDir("text-tools-benchmark", "/tmp/fake-project-root");
    expect(dir).toBe("/tmp/fake-project-root/reports/llm-externalizer/text-tools-benchmark");
  });

  // c9b (2026-09-18): pins the exact `sub` string each of the six
  // src/benchmark/<tool>/index.ts call sites passes, so a future rename of
  // one tool's literal (a typo, a copy-paste drift) is caught here instead
  // of silently scattering that tool's reports under a new, undocumented
  // sub-dir name.
  it.each([
    ["scan-folder-benchmark", "scan-folder/index.ts"],
    ["code-task-benchmark", "code-task/index.ts"],
    ["search-existing-benchmark", "search-existing/index.ts"],
    ["check-specs-benchmark", "check-specs/index.ts"],
    ["text-tools-benchmark", "text-tools/index.ts"],
    ["security-triage-benchmark", "security-triage/index.ts"],
  ])("pins %s (%s) to <mainRoot>/reports/llm-externalizer/<sub>", (sub) => {
    const dir = benchmarkSubReportDir(sub, "/tmp/fake-project-root");
    expect(dir).toBe(`/tmp/fake-project-root/reports/llm-externalizer/${sub}`);
  });
});
