// check_imports phase-1 prompt seam (TRDD-f45eeaa0).
//
// This prompt is now depended on by TWO consumers — the tool itself (both the
// grouped and ungrouped paths in index.ts) and the benchmark that scores models
// on it. That is the point of the extraction, and it is also the new risk: an
// edit here silently changes what a benchmarked model was asked to do, which
// would invalidate every ledger row recorded under the old wording without
// anything failing. So the text is pinned verbatim.

import { describe, it, expect } from "vitest";

import {
  buildCheckImportsExtractMessages,
  checkImportsExtractSystemPrompt,
} from "./prompt.js";

const EXAMPLE = "\n\n<FILE_FORMAT_EXAMPLE>";

describe("check_imports phase-1 prompt", () => {
  it("is pinned verbatim — an edit here invalidates existing benchmark rows", () => {
    expect(checkImportsExtractSystemPrompt("typescript", EXAMPLE)).toBe(
      "Expert typescript developer. Extract ALL file path references and import statements from the source code. " +
        "The source file is labeled with its full path inside a filename tag before the file-content tag — reference it by that path. " +
        "Include: import/require paths, file path strings, configuration references. " +
        'Return JSON: {"paths": ["./relative/path", "package-name", "../other/file"]}. ' +
        "Include both local (relative) and package imports. Be exhaustive." +
        EXAMPLE,
    );
  });

  it("asks for MORE than import specifiers — the reason scoring is recall-only", () => {
    // benchmark/check-imports/score.ts does not gate on precision because of
    // exactly this sentence. If it ever leaves the prompt, that decision should
    // be revisited, so assert it rather than trusting a comment to stay true.
    expect(checkImportsExtractSystemPrompt("typescript", "")).toContain(
      "file path strings, configuration references",
    );
    expect(checkImportsExtractSystemPrompt("typescript", "")).toContain("Be exhaustive");
  });

  it("interpolates the detected language", () => {
    expect(checkImportsExtractSystemPrompt("python", "")).toContain("Expert python developer.");
  });

  it("builds the system+user pair the tool sends", () => {
    const msgs = buildCheckImportsExtractMessages({
      lang: "typescript",
      fileBlock: "<FILE>",
      fileFormatExample: EXAMPLE,
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toBe(
      "Extract all import and file references from:\n\n<FILE>",
    );
  });

  it("prepends the caller's prompt with a blank line, and omits it when absent", () => {
    const withPrompt = buildCheckImportsExtractMessages({
      lang: "ts",
      userPrompt: "focus on config",
      fileBlock: "<FILE>",
      fileFormatExample: "",
    });
    expect(withPrompt[1].content).toBe(
      "focus on config\n\nExtract all import and file references from:\n\n<FILE>",
    );

    const without = buildCheckImportsExtractMessages({
      lang: "ts",
      fileBlock: "<FILE>",
      fileFormatExample: "",
    });
    expect(without[1].content?.startsWith("Extract all import")).toBe(true);
  });

  it("treats an EMPTY caller prompt as absent, not as a blank prefix", () => {
    const msgs = buildCheckImportsExtractMessages({
      lang: "ts",
      userPrompt: "",
      fileBlock: "<FILE>",
      fileFormatExample: "",
    });
    expect(msgs[1].content?.startsWith("Extract all import")).toBe(true);
  });
});
