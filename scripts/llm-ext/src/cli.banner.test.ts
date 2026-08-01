// Unit tests for the CLI success-banner helpers (Issue 4). The banner line goes
// to STDERR; the machine-readable report path stays on STDOUT. These test the
// pure logic (path extraction + banner formatting) imported from the
// side-effect-free cli-banner module — fully offline, zero spend.

import { describe, it, expect } from "vitest";
import { pickReportPath, formatSuccessBanner } from "./cli-banner.js";

describe("pickReportPath", () => {
  it("returns the single report path verbatim", () => {
    expect(pickReportPath("/tmp/reports/llm-externalizer/r.md")).toBe(
      "/tmp/reports/llm-externalizer/r.md",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(pickReportPath("   /tmp/r.md  \n")).toBe("/tmp/r.md");
  });

  it("picks the FIRST non-empty line when several are present", () => {
    expect(pickReportPath("\n\n/tmp/first.md\n/tmp/second.md\n")).toBe("/tmp/first.md");
  });

  it("returns undefined for an empty result (banner suppressed)", () => {
    expect(pickReportPath("")).toBeUndefined();
  });

  it("returns undefined for a whitespace-only result", () => {
    expect(pickReportPath("   \n\t\n  ")).toBeUndefined();
  });
});

describe("formatSuccessBanner", () => {
  it("formats the checkmark + tool + report path", () => {
    expect(formatSuccessBanner("code_task", "/tmp/r.md")).toBe(
      "✓ code_task complete — report: /tmp/r.md",
    );
  });

  it("returns undefined when there is no report path", () => {
    expect(formatSuccessBanner("code_task", "")).toBeUndefined();
  });
});
