// Hermetic tests for the check_against_specs pipeline core (P2a, zero-token
// model pipeline). NO network, NO module mocking of anything under test. The
// ONLY fake is the LLM seam (ensembleStreaming — check_against_specs's single
// LLM call site). The real pipeline runs end to end: REAL temp fixture files are
// read by the REAL readFileAsCodeBlock (including the `specs-` tag prefix on the
// spec file), FFD-batched by the REAL readAndGroupFiles, grouped by the REAL
// parseFileGroups/hasNamedGroups/autoGroupByHeuristic, and the REAL report
// assembly (per-file, batched, and per-group) produces the returned text.
//
// Mirrors src/benchmark/scan-folder/runner.test.ts and
// src/benchmark/code-task/runner.test.ts. check_against_specs has three output
// shapes, all exercised here:
//   - mode 0 (default, ungrouped) : one LLM call + one report per input file.
//   - mode 2 (batched)            : FFD bin-packed batch → one merged report.
//   - mode 1 (grouped)            : auto-grouped → one report per group.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  runCheckAgainstSpecs,
  CHECK_SPECS_SYSTEM_PROMPT,
  type CheckSpecsDeps,
  type CheckSpecsStreamingResult,
} from "../../check-specs/core.js";

// One real temp root under cwd (an allowed sanitizeInputPath root — os.tmpdir()
// is rejected on macOS). Real bytes on disk are what make the pipeline real:
// readFileAsCodeBlock / readAndGroupFiles read them, not a fixture object.
let root: string;
let specPath: string;
let aPath: string;
let bPath: string;
let subPath: string; // a file in a second directory → a second auto-group

beforeAll(() => {
  root = mkdtempSync(join(process.cwd(), "check-specs-test-"));
  specPath = join(root, "SPEC.md");
  writeFileSync(specPath, "# SPEC\n\nRULE-1: every export must be frozen.\n");
  aPath = join(root, "a.ts");
  bPath = join(root, "b.ts");
  writeFileSync(aPath, "export const a = 1;\n");
  writeFileSync(bPath, "export const b = 2;\n");
  const subDir = join(root, "sub");
  mkdirSync(subDir);
  subPath = join(subDir, "c.ts");
  writeFileSync(subPath, "export const c = 3;\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A stub StreamingResult the ensembleStreaming fake returns. */
function fakeStreamingResult(content: string): CheckSpecsStreamingResult {
  return {
    content,
    model: "vendor/test-model",
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    finishReason: "stop",
    truncated: false,
  };
}

/**
 * Base deps. The LLM seam defaults to throwing so a test that forgets to provide
 * it fails loudly. normalizePaths / resolveFolderPath are faithful tiny
 * re-implementations (the index.ts originals are pure path logic); formatFooter
 * has index.ts side effects (recordUsage/logRequest), so the stub returns a
 * marker footer we can assert the report assembly appended.
 */
function baseDeps(over: Partial<CheckSpecsDeps>): CheckSpecsDeps {
  return {
    useEnsemble: true,
    normalizePaths: (raw) => {
      if (!raw) return [];
      const arr = Array.isArray(raw) ? raw : [raw];
      return arr.filter((p): p is string => typeof p === "string" && p.length > 0);
    },
    // No folder_path in these tests → empty + an error (matches index.ts's shape).
    resolveFolderPath: () => ({ files: [], error: "no folder_path in test" }),
    ensembleStreaming: async () => {
      throw new Error("ensembleStreaming not provided by test");
    },
    formatFooter: () => "\n<!--footer-->",
    saveResponse: () => "memory://report.md",
    ensembleModelLabel: () => "vendor/test-model (ensemble)",
    resolveDefaultMaxTokens: () => 4096,
    ...over,
  };
}

function baseArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec_file_path: specPath,
    scan_secrets: false,
    redact_secrets: false,
    ...over,
  };
}

describe("runCheckAgainstSpecs — hermetic, real pipeline", () => {
  it("mode 0 (default): one LLM call and one report per input file, with the REAL spec + source bytes in the prompt", async () => {
    const userContents: string[] = [];
    const systemContents: string[] = [];
    const savedInputs: string[] = [];
    const savedContents: string[] = [];
    let call = 0;
    const deps = baseDeps({
      ensembleStreaming: async (messages) => {
        systemContents.push(messages.find((m) => m.role === "system")?.content ?? "");
        userContents.push(messages.find((m) => m.role === "user")?.content ?? "");
        call++;
        return fakeStreamingResult(`VIOLATION ${call}: RULE-1 broken.`);
      },
      saveResponse: (_tool, content, meta) => {
        savedContents.push(content);
        savedInputs.push(meta.inputFile ?? "");
        return `memory://report-${savedContents.length}.md`;
      },
    });

    const result = await runCheckAgainstSpecs(
      baseArgs({ input_files_paths: [aPath, bPath] }),
      deps,
    );

    // One LLM call per input file, one report per input file.
    expect(call).toBe(2);
    expect(result.isError).toBeFalsy();
    expect(result.content.map((p) => p.text).join("\n")).toBe(
      "memory://report-1.md\nmemory://report-2.md",
    );
    expect(savedInputs).toEqual([aPath, bPath]);

    // The REAL system prompt (not a stub) reached the model.
    expect(systemContents[0]).toBe(CHECK_SPECS_SYSTEM_PROMPT);
    expect(systemContents[0]).toContain("strict specification compliance auditor");

    // The REAL readFileAsCodeBlock embedded the spec under the specs- tag prefix
    // and the source file under the plain filename tag — proving the real file
    // reader ran, not a fixture string.
    expect(userContents[0]).toContain("<specs-filename>");
    expect(userContents[0]).toContain("RULE-1: every export must be frozen.");
    expect(userContents[0]).toContain("export const a = 1;");
    expect(userContents[0]).not.toContain("export const b = 2;");
    expect(userContents[1]).toContain("export const b = 2;");

    // REAL report assembly: LLM content + the footer the formatFooter seam returned.
    expect(savedContents[0]).toBe("VIOLATION 1: RULE-1 broken.\n<!--footer-->");
  });

  it("mode 0: a missing input file is reported per-file and never reaches the LLM seam", async () => {
    let call = 0;
    const deps = baseDeps({
      ensembleStreaming: async () => {
        call++;
        return fakeStreamingResult("VIOLATION: RULE-1 broken.");
      },
      saveResponse: () => "memory://ok.md",
    });
    const missing = join(root, "does-not-exist.ts");

    const result = await runCheckAgainstSpecs(
      baseArgs({ input_files_paths: [missing, aPath] }),
      deps,
    );

    // Only the existing file was sent to the model.
    expect(call).toBe(1);
    const text = result.content.map((p) => p.text).join("\n");
    expect(text).toContain(`FAILED: ${missing} — File not found`);
    expect(text).toContain("memory://ok.md");
  });

  it("mode 0: an empty LLM response is surfaced as a per-file FAILED line, not a saved report", async () => {
    let saves = 0;
    const deps = baseDeps({
      ensembleStreaming: async () => fakeStreamingResult("   \n  "),
      saveResponse: () => {
        saves++;
        return "memory://never.md";
      },
    });

    const result = await runCheckAgainstSpecs(
      baseArgs({ input_files_paths: [aPath] }),
      deps,
    );

    expect(saves).toBe(0);
    const text = result.content.map((p) => p.text).join("\n");
    expect(text).toBe(`FAILED: ${aPath} — LLM returned empty response`);
  });

  it("mode 2: the REAL FFD packer batches both files into one LLM call and one merged report", async () => {
    let call = 0;
    let lastUser = "";
    let savedContent = "";
    const deps = baseDeps({
      ensembleStreaming: async (messages) => {
        call++;
        lastUser = messages.find((m) => m.role === "user")?.content ?? "";
        return fakeStreamingResult("BATCH: 1 CRITICAL violation of RULE-1.");
      },
      saveResponse: (_tool, content) => {
        savedContent = content;
        return "memory://batch-merged.md";
      },
    });

    const result = await runCheckAgainstSpecs(
      baseArgs({ input_files_paths: [aPath, bPath], answer_mode: 2 }),
      deps,
    );

    // Both fixtures fit well under the 400 KB budget → exactly one batch.
    expect(call).toBe(1);
    expect(result.isError).toBeFalsy();
    expect(result.content.map((p) => p.text).join("\n")).toBe("memory://batch-merged.md");
    // The REAL readAndGroupFiles embedded every fixture's bytes into the single
    // user message, alongside the spec block.
    expect(lastUser).toContain("export const a = 1;");
    expect(lastUser).toContain("export const b = 2;");
    expect(lastUser).toContain("RULE-1: every export must be frozen.");
    expect(savedContent).toContain("BATCH: 1 CRITICAL violation of RULE-1.");
    expect(savedContent).toContain("<!--footer-->");
  });

  it("mode 2: extra instructions are injected into the batch prompt", async () => {
    let lastUser = "";
    const deps = baseDeps({
      ensembleStreaming: async (messages) => {
        lastUser = messages.find((m) => m.role === "user")?.content ?? "";
        return fakeStreamingResult("CLEAN — no spec violations found.");
      },
    });

    await runCheckAgainstSpecs(
      baseArgs({
        input_files_paths: [aPath],
        answer_mode: 2,
        instructions: "Only audit exported symbols.",
      }),
      deps,
    );

    expect(lastUser).toContain("## ADDITIONAL INSTRUCTIONS");
    expect(lastUser).toContain("Only audit exported symbols.");
  });

  it("mode 1: files in two directories auto-group into one LLM call and one report per group", async () => {
    let call = 0;
    const groupIds: (string | undefined)[] = [];
    const deps = baseDeps({
      ensembleStreaming: async () => {
        call++;
        return fakeStreamingResult(`GROUP FINDINGS ${call}`);
      },
      saveResponse: (_tool, _content, meta) => {
        groupIds.push(meta.groupId);
        return `memory://group-${groupIds.length}.md`;
      },
    });

    const result = await runCheckAgainstSpecs(
      baseArgs({ input_files_paths: [aPath, bPath, subPath], answer_mode: 1 }),
      deps,
    );

    // The REAL autoGroupByHeuristic buckets by (parent dir, extension): a.ts+b.ts
    // in root, c.ts in sub/ → two groups → one batched LLM call each.
    expect(call).toBe(2);
    expect(result.isError).toBeFalsy();
    const lines = result.content.map((p) => p.text).join("\n").split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/^\[group:[^\]]+\] memory:\/\/group-\d\.md$/);
    }
    // Every group report carried a real (non-empty) group id.
    expect(groupIds.every((g) => typeof g === "string" && g.length > 0)).toBe(true);
  });

  it("rejects a missing spec_file_path before any file is read or any LLM seam is touched", async () => {
    let call = 0;
    const deps = baseDeps({
      ensembleStreaming: async () => {
        call++;
        throw new Error("must not be called");
      },
    });

    const result = await runCheckAgainstSpecs(
      { input_files_paths: [aPath] } as Record<string, unknown>,
      deps,
    );

    expect(result.isError).toBe(true);
    expect(call).toBe(0);
    expect(result.content.map((p) => p.text).join("\n")).toContain(
      "FAILED: spec_file_path is required.",
    );
  });

  it("rejects a call with neither input_files_paths nor folder_path", async () => {
    let call = 0;
    const deps = baseDeps({
      ensembleStreaming: async () => {
        call++;
        throw new Error("must not be called");
      },
    });

    const result = await runCheckAgainstSpecs(baseArgs(), deps);

    expect(result.isError).toBe(true);
    expect(call).toBe(0);
    expect(result.content.map((p) => p.text).join("\n")).toContain(
      "FAILED: Provide input_files_paths or folder_path.",
    );
  });

  it("rejects an unreadable spec file with a FAILED result and no LLM call", async () => {
    let call = 0;
    const deps = baseDeps({
      ensembleStreaming: async () => {
        call++;
        throw new Error("must not be called");
      },
    });

    const result = await runCheckAgainstSpecs(
      baseArgs({ spec_file_path: join(root, "no-such-spec.md"), input_files_paths: [aPath] }),
      deps,
    );

    expect(result.isError).toBe(true);
    expect(call).toBe(0);
    expect(result.content.map((p) => p.text).join("\n")).toContain(
      "FAILED: Cannot read spec file:",
    );
  });
});
