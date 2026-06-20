// Hermetic tests for the code_task pipeline core (B1 Phase 3, TRDD-63314265).
// NO network, NO module mocking of anything under test. The ONLY fakes are the
// LLM seams: processFileCheck (the single/per-file-call seam) and
// ensembleStreaming (the multi-model batch seam). The real pipeline runs end to
// end: REAL temp fixture files are read and FFD-batched by the REAL
// readAndGroupFiles, REAL parseFileGroups/autoGroupByHeuristic drive grouping,
// and the REAL report-merge assembly produces the summary text.
//
// Mirrors src/benchmark/scan-folder/runner.test.ts. code_task is the richer
// tool, so this exercises BOTH modes:
//   - SINGLE  : one input path → processFileCheck seam.
//   - INLINE  : input_files_content only → ensembleStreaming seam.
//   - BATCH   : multiple input files → readAndGroupFiles + ensembleStreaming.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  runCodeTask,
  type CodeTaskDeps,
  type CodeTaskFileResult,
  type CodeTaskStreamingResult,
} from "../../code-task/core.js";

// One real temp root under cwd (an allowed sanitizeInputPath root — os.tmpdir()
// is rejected on macOS). Source fixtures go inside `srcRoot` so the batch path's
// REAL readAndGroupFiles can read their bytes.
let srcRoot: string;

beforeAll(() => {
  srcRoot = mkdtempSync(join(process.cwd(), "code-task-test-src-"));
  writeFileSync(join(srcRoot, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(srcRoot, "b.ts"), "export const b = 2;\n");
  writeFileSync(join(srcRoot, "c.ts"), "export const c = 3;\n");
});

afterAll(() => {
  rmSync(srcRoot, { recursive: true, force: true });
});

/** A stub StreamingResult the ensembleStreaming fake returns. */
function fakeStreamingResult(content: string): CodeTaskStreamingResult {
  return {
    content,
    model: "vendor/test-model",
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    finishReason: "stop",
    truncated: false,
  };
}

/**
 * Base deps. The two LLM seams default to throwing so a test that forgets to
 * provide the seam it exercises fails loudly. normalizePaths / resolveFolderPath
 * are faithful tiny re-implementations (the index.ts originals are pure path
 * logic); codeTaskSystemPrompt / ensembleModelLabel / formatFooter are stubs
 * with no side effects.
 */
function baseDeps(over: Partial<CodeTaskDeps>): CodeTaskDeps {
  return {
    useEnsemble: true,
    defaultTemperature: 0.1,
    normalizePaths: (raw) => {
      if (!raw) return [];
      const arr = Array.isArray(raw) ? raw : [raw];
      return arr.filter((p): p is string => typeof p === "string" && p.length > 0);
    },
    // No folder_path is used by these tests → return empty + an error (matches
    // index.ts's "no matching files" shape). Tests pass input_files_paths.
    resolveFolderPath: () => ({ files: [], error: "no folder_path in test" }),
    processFileCheck: async () => {
      throw new Error("processFileCheck not provided by test");
    },
    ensembleStreaming: async () => {
      throw new Error("ensembleStreaming not provided by test");
    },
    // formatFooter has index.ts side effects (recordUsage/logRequest); the stub
    // returns an empty footer so merged content equals the raw LLM content.
    formatFooter: () => "",
    saveResponse: () => "memory://report",
    robustPerFileProcess: async () => {
      throw new Error("robustPerFileProcess not provided by test");
    },
    codeTaskSystemPrompt: (lang) => `system prompt for ${lang}`,
    ensembleModelLabel: () => "vendor/test-model (ensemble)",
    resolveDefaultMaxTokens: () => 4096,
    ...over,
  };
}

function baseArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instructions: "Analyse each file and report findings.",
    language: "typescript",
    scan_secrets: false,
    redact_secrets: false,
    ...over,
  };
}

describe("runCodeTask — hermetic, real pipeline", () => {
  it("single mode: one input path delegates to processFileCheck and returns its report path", async () => {
    let calls = 0;
    const deps = baseDeps({
      processFileCheck: async (filePath) => {
        calls++;
        return { filePath, success: true, reportPath: "memory://single-report.md" } as CodeTaskFileResult;
      },
    });
    const result = await runCodeTask(
      baseArgs({ input_files_paths: join(srcRoot, "a.ts") }),
      deps,
    );

    // The single-file optimized path ran the per-file seam exactly once and
    // never touched the ensemble seam.
    expect(calls).toBe(1);
    expect(result.isError).toBeFalsy();
    const text = result.content.map((p) => p.text).join("\n");
    expect(text).toBe("memory://single-report.md");
  });

  it("inline mode: input_files_content only runs the ensemble seam and saves one report", async () => {
    let ensembleCalls = 0;
    let savedContent = "";
    const deps = baseDeps({
      ensembleStreaming: async () => {
        ensembleCalls++;
        return fakeStreamingResult("INLINE FINDINGS: ok.");
      },
      saveResponse: (_tool, content) => {
        savedContent = content;
        return "memory://inline-report.md";
      },
    });
    const result = await runCodeTask(
      baseArgs({ input_files_content: "const x = 1;" }),
      deps,
    );

    expect(ensembleCalls).toBe(1);
    expect(result.isError).toBeFalsy();
    const text = result.content.map((p) => p.text).join("\n");
    expect(text).toBe("memory://inline-report.md");
    // The saved content is the raw LLM content (empty footer stub).
    expect(savedContent).toContain("INLINE FINDINGS: ok.");
  });

  it("batch mode (mode 2): multiple files are FFD-batched, the ensemble seam runs, and one merged report is saved", async () => {
    // The REAL readAndGroupFiles reads the three fixture files and packs them
    // (well under the 400 KB budget) into a single batch → one ensemble call.
    let ensembleCalls = 0;
    let lastUserContent = "";
    let savedContent = "";
    const deps = baseDeps({
      ensembleStreaming: async (messages) => {
        ensembleCalls++;
        lastUserContent = messages.find((m) => m.role === "user")?.content ?? "";
        return fakeStreamingResult("BATCH FINDINGS: all three look fine.");
      },
      saveResponse: (_tool, content) => {
        savedContent = content;
        return "memory://batch-merged.md";
      },
    });
    const result = await runCodeTask(
      baseArgs({
        input_files_paths: [
          join(srcRoot, "a.ts"),
          join(srcRoot, "b.ts"),
          join(srcRoot, "c.ts"),
        ],
        answer_mode: 2,
      }),
      deps,
    );

    // One batch formed (all three fixtures fit) → exactly one ensemble call.
    expect(ensembleCalls).toBe(1);
    expect(result.isError).toBeFalsy();
    const text = result.content.map((p) => p.text).join("\n");
    expect(text).toBe("memory://batch-merged.md");
    // The REAL readAndGroupFiles embedded every fixture's bytes into the user
    // message the ensemble seam saw, proving the real batching ran.
    expect(lastUserContent).toContain("export const a = 1;");
    expect(lastUserContent).toContain("export const b = 2;");
    expect(lastUserContent).toContain("export const c = 3;");
    expect(savedContent).toContain("BATCH FINDINGS:");
  });

  it("batch mode (mode 0, sequential): lists one report path per input file via processFileCheck", async () => {
    // answer_mode 0 + multiple files + default max_retries (1) → the simple
    // sequential per-file path: processFileCheck once per file, no ensemble.
    let calls = 0;
    let ensembleCalls = 0;
    const deps = baseDeps({
      processFileCheck: async (filePath) => {
        calls++;
        return { filePath, success: true, reportPath: `memory://r${calls}.md` } as CodeTaskFileResult;
      },
      ensembleStreaming: async () => {
        ensembleCalls++;
        return fakeStreamingResult("should not be called");
      },
    });
    const result = await runCodeTask(
      baseArgs({
        input_files_paths: [
          join(srcRoot, "a.ts"),
          join(srcRoot, "b.ts"),
          join(srcRoot, "c.ts"),
        ],
        answer_mode: 0,
      }),
      deps,
    );

    expect(calls).toBe(3);
    expect(ensembleCalls).toBe(0);
    expect(result.isError).toBeFalsy();
    const text = result.content.map((p) => p.text).join("\n");
    // Three report paths, one per fixture file.
    expect((text.match(/^memory:\/\/r\d\.md$/gm) ?? []).length).toBe(3);
  });

  it("batch mode (mode 0, robust): max_retries>1 routes through the robustPerFileProcess seam", async () => {
    // max_retries>1 + mode 0 + multiple files → the robust path. We fake the
    // injected robustPerFileProcess and assert code_task formats its result.
    let robustCalls = 0;
    const deps = baseDeps({
      robustPerFileProcess: async (files) => {
        robustCalls++;
        const succeeded = files.map((filePath, i) => ({
          filePath,
          success: true,
          reportPath: `memory://robust${i}.md`,
        })) as CodeTaskFileResult[];
        return {
          results: succeeded,
          succeeded,
          failed: [],
          skipped: [],
          aborted: false,
          abortReason: "",
        };
      },
    });
    const result = await runCodeTask(
      baseArgs({
        input_files_paths: [join(srcRoot, "a.ts"), join(srcRoot, "b.ts")],
        answer_mode: 0,
        max_retries: 3,
      }),
      deps,
    );

    expect(robustCalls).toBe(1);
    expect(result.isError).toBeFalsy();
    const text = result.content.map((p) => p.text).join("\n");
    expect(text).toContain("memory://robust0.md");
    expect(text).toContain("memory://robust1.md");
  });

  it("returns a validation error without ever calling any LLM seam when instructions are missing", async () => {
    let pfc = 0;
    let ens = 0;
    const deps = baseDeps({
      processFileCheck: async () => { pfc++; throw new Error("nope"); },
      ensembleStreaming: async () => { ens++; throw new Error("nope"); },
    });
    // No instructions and no instructions_files_paths → must fail validation
    // before any file is read or any LLM seam is touched.
    const result = await runCodeTask(
      baseArgs({ instructions: undefined, input_files_paths: join(srcRoot, "a.ts") }),
      deps,
    );
    expect(result.isError).toBe(true);
    expect(pfc).toBe(0);
    expect(ens).toBe(0);
    const text = result.content.map((p) => p.text).join("\n");
    expect(text).toContain("Either instructions or instructions_files_paths must be provided");
  });
});
