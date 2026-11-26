// C9 write-roots sweep (2026-09-18): buildReportPath()'s non-isolated
// (LLM_EXT_CONFIG_DIR unset) branch used to return
// `<mainRoot>/reports/benchmark/<ts>-model-comparison.md` — OUTSIDE every
// USER-approved write root. It now routes through defaultScratchDir() (TRDD-PNU8XECB),
// the gitignored <project-root>/reports_dev/llm-externalizer/ scratch root.
//
// The LLM_EXT_CONFIG_DIR (isolated) branch already had coverage via
// populate-default-profile.test.ts's fix-queue-29 test (a full run through
// runKeywordSweep) — this test targets only the branch that changed here,
// directly against the now-exported buildReportPath(), no network/fetch
// mocking needed since the function does zero I/O of its own (mkdirSync/
// writeFileSync happen at the call site, not inside buildReportPath).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { buildReportPath } from "./index.js";
import { _resetDefaultOutputDirCache } from "../project-root.js";

describe("buildReportPath (C9 write-roots sweep)", () => {
  const prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
  const prevConfigDir = process.env.LLM_EXT_CONFIG_DIR;
  const prevOutputDir = process.env.LLM_EXT_OUTPUT_DIR;
  // TRDD-5D50HBXA: test-hermetic-config.ts now sets LLM_EXT_SCRATCH_DIR for every test; this test asserts the
  // project-root default, so it must unset it for its own duration and restore it after.
  const prevScratchDir = process.env.LLM_EXT_SCRATCH_DIR;

  // c9b: reset in beforeEach too, not just afterEach — a PRECEDING test file
  // in the same vitest worker can leave defaultOutputDir()'s module-level
  // cache populated with its own CLAUDE_PROJECT_DIR before this suite's own
  // env is set, and the cache (project-root.ts) only recomputes on a reset.
  beforeEach(() => {
    _resetDefaultOutputDirCache();
  });

  afterEach(() => {
    if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
    if (prevConfigDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevConfigDir;
    if (prevOutputDir === undefined) delete process.env.LLM_EXT_OUTPUT_DIR;
    else process.env.LLM_EXT_OUTPUT_DIR = prevOutputDir;
    if (prevScratchDir === undefined) delete process.env.LLM_EXT_SCRATCH_DIR;
    else process.env.LLM_EXT_SCRATCH_DIR = prevScratchDir;
    _resetDefaultOutputDirCache();
  });

  it("routes the non-isolated default under <root>/reports_dev/llm-externalizer/benchmark/, not <root>/reports/benchmark/ directly", () => {
    // resolveProjectMainRoot() only honors CLAUDE_PROJECT_DIR when it
    // existsSync() on disk (project-root.ts) — a nonexistent placeholder path
    // would silently fall back to process.cwd() and pass vacuously.
    const fakeRoot = mkdtempSync(join(tmpdir(), "c9-build-report-path-"));
    try {
      delete process.env.LLM_EXT_CONFIG_DIR;
      delete process.env.LLM_EXT_OUTPUT_DIR;
      delete process.env.LLM_EXT_SCRATCH_DIR;
      process.env.CLAUDE_PROJECT_DIR = fakeRoot;
      _resetDefaultOutputDirCache();

      const path = buildReportPath();
      expect(path.startsWith(join(fakeRoot, "reports_dev", "llm-externalizer", "benchmark") + sep)).toBe(true);
      expect(path.endsWith("-model-comparison.md")).toBe(true);
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});
