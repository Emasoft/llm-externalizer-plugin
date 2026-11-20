/**
 * vitest `setupFiles` entry — isolates getConfigDir() away from the real
 * ~/.llm-externalizer during the suite.
 *
 * WHY: dozens of tests exercise code paths that write through getConfigDir()
 * (history.log, model-events.log, free-cooldowns.json, ...). Any test that
 * forgets to set its own LLM_EXT_CONFIG_DIR silently falls through to the
 * real ~/.llm-externalizer default and corrupts the user's real state (a
 * `code_task FAIL` fixture line landed in the real history.log, and real
 * free-pool cooldowns were rewritten — measured 2026-09-16, `npm test` run
 * from publish.py --check-only with no LLM_EXT_CONFIG_DIR/TMPDIR set). Fix it
 * once, for every test file, instead of auditing every call site by hand.
 *
 * Uses "/tmp" as the mkdtemp root, NOT os.tmpdir(): config.ts's getConfigDir()
 * only accepts a dir under homedir() or realpath("/tmp") (its own M8
 * path-traversal guard). On macOS os.tmpdir() resolves to /var/folders/.../T,
 * which is OUTSIDE that allowlist — getConfigDir() would throw the moment any
 * code under test called it.
 *
 * Must run BEFORE any test-file import touches src/index.ts, because that
 * module computes `LOG_DIR = join(getConfigDir(), "logs")` at import time
 * (module top level, not inside a function). A vitest setupFile runs as its
 * own module, fully, before the test file's own imports are resolved, so this
 * ordering holds without extra plumbing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";

let createdDir: string | null = null;
let createdGovernorDir: string | null = null;
let createdScratchDir: string | null = null;
let createdOutputDir: string | null = null;

if (!process.env.LLM_EXT_CONFIG_DIR) {
  // Name must NOT match /llm[-_]?ext/i — that is the leak marker
  // test-tmpdir-guard.ts's globalSetup checks for; a name that DID match
  // would make every hermetic run look like a leak.
  createdDir = mkdtempSync(join("/tmp", "cfgiso-"));
  process.env.LLM_EXT_CONFIG_DIR = createdDir;
}

// Without this every vitest worker, and every CLI a test spawns, would join the user's live governor and each
// other's, waiting on real leases. Same leak-marker rule for the name as above: no /llm[-_]?ext/i.
if (!process.env.LLM_EXT_GOVERNOR_DIR) {
  createdGovernorDir = mkdtempSync(join("/tmp", "goviso-"));
  process.env.LLM_EXT_GOVERNOR_DIR = createdGovernorDir;
}

// WHY (TRDD-5D50HBXA): defaultScratchDir() / defaultOutputDir() (project-root.ts) fall back to
// <CLAUDE_PROJECT_DIR or cwd>/reports_dev/llm-externalizer and <...>/reports/llm-externalizer. A test that reaches
// get_settings (settings_edit.yaml), a benchmark or a report writer without its own LLM_EXT_SCRATCH_DIR /
// LLM_EXT_OUTPUT_DIR therefore wrote into the REAL project's report folders (settings_edit.yaml re-written
// 2026-11-20 by single-file runs). Same isolation as cfgiso-/goviso-: two fresh dirs, removed in afterAll.
// Each root gets its own dir so scratch and final-report writes stay separable; tests that exercise the default
// resolution delete or set these variables themselves. Name must NOT match /llm[-_]?ext/i (leak marker).
if (!process.env.LLM_EXT_SCRATCH_DIR) {
  createdScratchDir = mkdtempSync(join("/tmp", "scriso-"));
  process.env.LLM_EXT_SCRATCH_DIR = createdScratchDir;
}
if (!process.env.LLM_EXT_OUTPUT_DIR) {
  createdOutputDir = mkdtempSync(join("/tmp", "outiso-"));
  process.env.LLM_EXT_OUTPUT_DIR = createdOutputDir;
}
// A suite running in parallel, or a 2-core runner, sits over the default limits, and with no CPU floor every job would wait
// for as long as it stays there. A test about the limits sets its own strict ones.
process.env.LLM_EXT_GOVERNOR_CPU_LIMIT_PCT ??= "100";
process.env.LLM_EXT_GOVERNOR_RAM_LIMIT_PCT ??= "99";
// boot() calls installUsageRule(), which writes the REAL ~/.claude/rules/use-llm-externalizer.md; opt out
// for every test (tests that deliberately turn installation ON set their own value).
process.env.LLM_EXT_INSTALL_RULE ??= "0";
afterAll(() => {
  if (createdDir) {
    delete process.env.LLM_EXT_CONFIG_DIR;
    rmSync(createdDir, { recursive: true, force: true });
    createdDir = null;
  }
  if (createdScratchDir) {
    delete process.env.LLM_EXT_SCRATCH_DIR;
    rmSync(createdScratchDir, { recursive: true, force: true });
    createdScratchDir = null;
  }
  if (createdOutputDir) {
    delete process.env.LLM_EXT_OUTPUT_DIR;
    rmSync(createdOutputDir, { recursive: true, force: true });
    createdOutputDir = null;
  }
  if (createdGovernorDir) {
    delete process.env.LLM_EXT_GOVERNOR_DIR;
    rmSync(createdGovernorDir, { recursive: true, force: true });
    createdGovernorDir = null;
  }
});
