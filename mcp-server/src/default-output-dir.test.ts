// Test for the report-output-dir resolution path.
// Covers the override env var, the CLAUDE_PROJECT_DIR-verbatim anchor
// (no git climbing), and the fallback to cwd when CLAUDE_PROJECT_DIR
// is unset. Reports always land in <main project dir>/reports/llm-externalizer.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _resetDefaultOutputDirCache } from "./index.js";

// We test the cached function indirectly by manipulating env vars + calling
// _resetDefaultOutputDirCache between cases.

// Capture the original env so we can restore after each case.
const ORIG_ENV = {
  LLM_OUTPUT_DIR: process.env.LLM_OUTPUT_DIR,
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
};

beforeEach(() => {
  delete process.env.LLM_OUTPUT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  _resetDefaultOutputDirCache();
});

afterEach(() => {
  if (ORIG_ENV.LLM_OUTPUT_DIR !== undefined) process.env.LLM_OUTPUT_DIR = ORIG_ENV.LLM_OUTPUT_DIR;
  else delete process.env.LLM_OUTPUT_DIR;
  if (ORIG_ENV.CLAUDE_PROJECT_DIR !== undefined) process.env.CLAUDE_PROJECT_DIR = ORIG_ENV.CLAUDE_PROJECT_DIR;
  else delete process.env.CLAUDE_PROJECT_DIR;
  _resetDefaultOutputDirCache();
});

/** Helper: import defaultOutputDir() fresh by re-importing the module.
 *  We pull the helper from `index.ts` indirectly via an internal re-export
 *  added for testing. */
async function resolveOnce(): Promise<string> {
  // The exported reset function plus a fresh import keeps the test
  // hermetic — each case computes the path under its env setup, not
  // the cached value from an earlier case.
  _resetDefaultOutputDirCache();
  const mod = (await import("./index.js")) as unknown as {
    _testDefaultOutputDir?: () => string;
  };
  // Expose a tiny helper from the production module purely for this
  // test. If it's not present yet, the test fails loudly so the wiring
  // gap surfaces during code review.
  if (typeof mod._testDefaultOutputDir !== "function") {
    throw new Error("index.ts does not export _testDefaultOutputDir for testing");
  }
  return mod._testDefaultOutputDir();
}

describe("defaultOutputDir resolution (Issue #5)", () => {
  it("LLM_OUTPUT_DIR env var wins over everything", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "dod-env-"));
    try {
      process.env.LLM_OUTPUT_DIR = tmp;
      const got = await resolveOnce();
      expect(got).toBe(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("anchors on CLAUDE_PROJECT_DIR verbatim + reports/llm-externalizer (git presence at the root is ignored)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "dod-git-"));
    try {
      // Make tmp a git repo with a commit. The resolver must IGNORE git
      // entirely and use CLAUDE_PROJECT_DIR verbatim — this case proves
      // that a git repo at the project root does not change the answer.
      execSync("git init -q --initial-branch=main", { cwd: tmp });
      writeFileSync(join(tmp, "x"), "");
      execSync(`git -c user.email=t@t -c user.name=t add x && git -c user.email=t@t -c user.name=t commit -q -m init`, { cwd: tmp });
      process.env.CLAUDE_PROJECT_DIR = tmp;
      const got = await resolveOnce();
      // Path may resolve through a /private symlink on macOS — both spellings are correct.
      expect(
        got === join(tmp, "reports", "llm-externalizer") ||
        got === join("/private" + tmp, "reports", "llm-externalizer"),
      ).toBe(true);
      expect(got.endsWith(`/reports/llm-externalizer`)).toBe(true);
      expect(got).not.toContain("llm_externalizer");
      expect(got).not.toContain("reports_dev");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("anchors on CLAUDE_PROJECT_DIR even when it's a SUBDIR of a git repo (does NOT climb to the git root)", async () => {
    // Regression: reports must land in the project dir, never an ancestor repo.
    const repo = mkdtempSync(join(tmpdir(), "dod-nested-"));
    try {
      execSync("git init -q --initial-branch=main", { cwd: repo });
      const sub = join(repo, "packages", "app");
      mkdirSync(sub, { recursive: true });
      process.env.CLAUDE_PROJECT_DIR = sub;
      const got = await resolveOnce();
      // The subdir, NOT `repo`/reports/llm-externalizer.
      expect(got).toBe(join(sub, "reports", "llm-externalizer"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("falls back to CLAUDE_PROJECT_DIR when it isn't a git repo", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "dod-nongit-"));
    try {
      // NO `git init` — just a plain dir.
      process.env.CLAUDE_PROJECT_DIR = tmp;
      const got = await resolveOnce();
      expect(got.endsWith("/reports/llm-externalizer")).toBe(true);
      // Fallback should anchor on CLAUDE_PROJECT_DIR itself, not somewhere else.
      expect(got.startsWith(tmp) || got.startsWith("/private" + tmp)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("caches across calls (same value on the 2nd lookup, even if env changes)", async () => {
    const tmp1 = mkdtempSync(join(tmpdir(), "dod-cache1-"));
    const tmp2 = mkdtempSync(join(tmpdir(), "dod-cache2-"));
    try {
      process.env.LLM_OUTPUT_DIR = tmp1;
      const a = await resolveOnce(); // _resetDefaultOutputDirCache called inside
      expect(a).toBe(tmp1);
      // Change env, do NOT reset cache: the cached value should hold.
      process.env.LLM_OUTPUT_DIR = tmp2;
      const mod = (await import("./index.js")) as unknown as {
        _testDefaultOutputDir?: () => string;
      };
      const b = mod._testDefaultOutputDir!(); // no reset → cache hit
      expect(b).toBe(tmp1);
    } finally {
      rmSync(tmp1, { recursive: true, force: true });
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});
