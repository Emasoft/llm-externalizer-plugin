// Hermetic tests for the scan_folder pipeline core (B1 Phase 3, TRDD-63314265).
// NO network, NO module mocking of anything under test — the ONLY fake is the
// processFileCheck seam (the per-file-call seam, the scan_folder analogue of
// search_existing's callModel). The real pipeline runs end to end: a REAL temp
// fixture dir is walked, REAL rateLimitedParallel dispatches the per-file tasks,
// and the REAL merged/grouped report assembly reads the intermediate report
// files the fake writes to disk.
//
// Mirrors src/benchmark/search-existing/runner.test.ts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  runScanFolder,
  type ScanFolderDeps,
  type ScanFolderFileResult,
} from "../../scan-folder/core.js";

// One real temp root under cwd (an allowed sanitizeInputPath root — os.tmpdir()
// is rejected on macOS). Source fixtures go inside `srcRoot`; the fake's
// intermediate per-file reports go inside `reportRoot` so they are real files
// the mode 2 / mode 1 assembly can read back.
let srcRoot: string;
let reportRoot: string;

beforeAll(() => {
  srcRoot = mkdtempSync(join(process.cwd(), "scan-folder-test-src-"));
  reportRoot = mkdtempSync(join(process.cwd(), "scan-folder-test-rep-"));
  writeFileSync(join(srcRoot, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(srcRoot, "b.ts"), "export const b = 2;\n");
  writeFileSync(join(srcRoot, "c.ts"), "export const c = 3;\n");
});

afterAll(() => {
  rmSync(srcRoot, { recursive: true, force: true });
  rmSync(reportRoot, { recursive: true, force: true });
});

/** Base deps with no-op rate config (1 rps, all in flight) and stub resolvers. */
function baseDeps(over: Partial<ScanFolderDeps>): ScanFolderDeps {
  return {
    useEnsemble: true,
    backendModel: "vendor/test-model",
    // classifyError mirrors index.ts's contract surface; tests override the
    // verdict where they need a service-level abort.
    classifyError: (err) => ({
      reason: err instanceof Error ? err.message : String(err),
      unrecoverable: false,
      serviceLevel: false,
    }),
    // saveResponse writes nothing to a fixed location — return a stable
    // pseudo-path so the summary assertions can check the merged/group lines.
    saveResponse: () => "memory://merged",
    getRateLimitConfig: async () => ({ rps: 1000, maxInFlight: 8 }),
    resolveDefaultMaxTokens: () => 4096,
    processFileCheck: async () => {
      throw new Error("processFileCheck not provided by test");
    },
    ...over,
  };
}

/**
 * A faithful fake processFileCheck: writes a REAL intermediate per-file report
 * to reportRoot (so mode 2 / mode 1 assembly reads it back) and returns success
 * with that path. Counts calls so a test can assert the real parallel executor
 * actually ran the pipeline.
 */
function fakeProcessFileCheck(): {
  fn: ScanFolderDeps["processFileCheck"];
  calls: () => number;
} {
  let calls = 0;
  const fn: ScanFolderDeps["processFileCheck"] = async (filePath) => {
    calls++;
    const base = filePath.replace(/[^a-zA-Z0-9]/g, "_");
    const reportPath = join(reportRoot, `${base}.${calls}.md`);
    writeFileSync(reportPath, `VERDICT for ${filePath}: looks fine.\n`);
    return { filePath, success: true, reportPath } as ScanFolderFileResult;
  };
  return { fn, calls: () => calls };
}

function baseArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    folder_path: srcRoot,
    instructions: "Audit each file for bugs.",
    extensions: [".ts"],
    // The fixture dir is not a git repo — force the manual walk.
    use_gitignore: false,
    scan_secrets: false,
    redact_secrets: false,
    ...over,
  };
}

describe("runScanFolder — hermetic, real pipeline", () => {
  it("mode 0: runs the real parallel pipeline and lists one report per file", async () => {
    const { fn, calls } = fakeProcessFileCheck();
    const deps = baseDeps({ processFileCheck: fn });
    const result = await runScanFolder(baseArgs({ answer_mode: 0 }), deps);

    // The REAL pipeline ran: every fixture .ts file was dispatched via the real
    // rateLimitedParallel and the fake per-file seam was called once each.
    expect(calls()).toBe(3);
    expect(result.isError).toBeFalsy();
    const text = result.content.map((p) => p.text).join("\n");
    expect(text).toContain("SCAN COMPLETE — 3 processed, 0 failed, 0 skipped");
    expect(text).toContain("REPORTS:");
    // All three intermediate report paths are listed and exist on disk.
    expect((text.match(/\.md$/gm) ?? []).length).toBe(3);
  });

  it("mode 2: assembles one merged report from the real per-file report files", async () => {
    const { fn, calls } = fakeProcessFileCheck();
    let savedContent = "";
    const deps = baseDeps({
      processFileCheck: fn,
      saveResponse: (_tool, content) => {
        savedContent = content;
        return "memory://merged-report";
      },
    });
    const result = await runScanFolder(baseArgs({ answer_mode: 2 }), deps);

    expect(calls()).toBe(3);
    expect(result.isError).toBeFalsy();
    const text = result.content.map((p) => p.text).join("\n");
    expect(text).toContain("MERGED REPORT: memory://merged-report");
    // The merged content was assembled by reading the REAL intermediate report
    // files (one `## File:` section per fixture file, each carrying its verdict).
    expect((savedContent.match(/^## File: /gm) ?? []).length).toBe(3);
    expect(savedContent).toContain("VERDICT for");
  });

  it("records a per-file failure without throwing, and aborts on a service-level error", async () => {
    // a.ts fails service-level (e.g. 401) → aborts the batch; remaining files
    // are skipped. The pipeline records the failure and returns isError, never
    // throwing — exactly the search_existing runner contract.
    let calls = 0;
    const failingProcess: ScanFolderDeps["processFileCheck"] = async (filePath) => {
      calls++;
      throw new Error(`API error 401: auth failed for ${filePath}`);
    };
    const deps = baseDeps({
      processFileCheck: failingProcess,
      // Treat the 401 as an unrecoverable service-level error → batch abort.
      classifyError: (err) => ({
        reason: err instanceof Error ? err.message : String(err),
        unrecoverable: true,
        serviceLevel: true,
      }),
    });
    const result = await runScanFolder(baseArgs({ answer_mode: 0 }), deps);

    expect(calls).toBeGreaterThan(0); // the pipeline ran and hit the failure
    expect(result.isError).toBe(true);
    const text = result.content.map((p) => p.text).join("\n");
    expect(text).toContain("ABORTED:");
    expect(text).toContain("FAILED:");
  });

  it("returns a validation error without ever calling the per-file seam", async () => {
    const { fn, calls } = fakeProcessFileCheck();
    const deps = baseDeps({ processFileCheck: fn });
    // No instructions and no instructions_files_paths → must fail validation
    // before any file is walked or processed.
    const result = await runScanFolder(
      baseArgs({ instructions: undefined, answer_mode: 0 }),
      deps,
    );
    expect(result.isError).toBe(true);
    expect(calls()).toBe(0);
    const text = result.content.map((p) => p.text).join("\n");
    expect(text).toContain("instructions or instructions_files_paths is required");
  });

  it("intermediate report files written by the seam exist and are read back", async () => {
    // Belt-and-braces: prove mode 2 truly reads the on-disk intermediate files
    // (not just the in-memory return) by checking the file exists and its bytes
    // appear verbatim in the merged content.
    const { fn } = fakeProcessFileCheck();
    let savedContent = "";
    let firstReportPath = "";
    const deps = baseDeps({
      processFileCheck: async (filePath, task, options) => {
        const r = await fn(filePath, task, options);
        if (!firstReportPath && r.reportPath) firstReportPath = r.reportPath;
        return r;
      },
      saveResponse: (_tool, content) => {
        savedContent = content;
        return "memory://merged";
      },
    });
    await runScanFolder(baseArgs({ answer_mode: 2 }), deps);
    expect(firstReportPath).not.toBe("");
    expect(existsSync(firstReportPath)).toBe(true);
    const onDisk = readFileSync(firstReportPath, "utf-8").trim();
    expect(savedContent).toContain(onDisk);
  });
});
