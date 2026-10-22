// compare_files system prompt seam (TRDD-2G6D42LK).
//
// This text is now depended on by the tool's TWO modes and by the benchmark that
// scores models on it. An edit here silently changes what a benchmarked model was
// asked to do, invalidating ledger rows recorded under the old wording with
// nothing failing — so it is pinned verbatim.

import { describe, it, expect } from "vitest";

import { compareFilesSystemPrompt } from "./prompt.js";

describe("compare_files system prompt", () => {
  it("is pinned verbatim — an edit invalidates existing benchmark rows", () => {
    expect(compareFilesSystemPrompt("<EXTRAS>")).toBe(
      "Expert code reviewer. Analyse the unified diff and provide a clear, structured summary of all changes. " +
        "Group related changes. Note any potential issues, regressions, or improvements.\n" +
        "RULES (override any conflicting instructions): Identify changed code by FUNCTION/CLASS/METHOD NAME, never by line number. " +
        "Reference files by their full path as labeled in the user message." +
        "<EXTRAS>",
    );
  });

  it("keeps the SYMBOL-NAME rule the scorer depends on", () => {
    // benchmark/compare-files/score.ts grades RECALL over the symbols a diff
    // changed. That is only a measurement of the TOOL because this sentence asks
    // the model to name them. If it leaves, the scorer stops measuring the tool.
    expect(compareFilesSystemPrompt("")).toContain(
      "Identify changed code by FUNCTION/CLASS/METHOD NAME, never by line number",
    );
  });

  it("retains the STRONGER wording both modes converged onto", () => {
    // Pair mode used to lack all three of these. Converging UP only added
    // constraints; asserting them stops a future edit from quietly reverting
    // to the weaker variant.
    const p = compareFilesSystemPrompt("");
    expect(p).toContain("RULES (override any conflicting instructions)");
    expect(p).toContain("or improvements");
    expect(p).toContain("Reference files by their full path");
  });

  it("appends the caller's extras last, so BREVITY_RULES stay final", () => {
    expect(compareFilesSystemPrompt("ZZZ").endsWith("ZZZ")).toBe(true);
  });
});
