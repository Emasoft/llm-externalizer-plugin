/**
 * Resolve the user's MAIN project directory that report writes anchor on, so
 * reports ALWAYS land under `<main-project-dir>/reports/<component>/` — never in
 * a subfolder, a worktree, an enclosing repo, or the plugin install cache.
 *
 * SINGLE SOURCE OF TRUTH — every report-path resolver in the server routes here.
 *
 * The main project dir is `$CLAUDE_PROJECT_DIR` (the directory Claude Code is
 * operating in). It does NOT necessarily coincide with a git folder, so we must
 * NOT use git to find the root:
 *   - linked worktrees: the git main-worktree ≠ the dir the agent works in;
 *   - a monorepo whose subfolders each have their OWN git while the root has
 *     none: `git` from anywhere resolves to a subfolder repo, never the root;
 *   - a git-less project root.
 * In every one of those cases `git worktree list` (or any git-root climb) picks
 * the WRONG directory and scatters reports outside the project. So this resolver
 * deliberately uses NO git at all.
 *
 * Resolution order (highest precedence first):
 *   1. `override` — an explicit caller-supplied root (e.g. an `output_dir` /
 *      `mainRoot` the caller already resolved). Honored verbatim.
 *   2. `$CLAUDE_PROJECT_DIR` when it exists on disk — the main project dir Claude
 *      Code sets in the MCP-stdio env. Used VERBATIM.
 *   3. `process.cwd()` — last resort for a direct CLI run with no
 *      CLAUDE_PROJECT_DIR (the user's shell cwd is their project). NEVER git.
 *
 * A per-call explicit `output_dir` still overrides everything upstream of this.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export function resolveProjectMainRoot(override?: string): string {
  if (override && override.length > 0) return override;

  const projDir = process.env.CLAUDE_PROJECT_DIR;
  if (projDir && projDir.length > 0 && existsSync(projDir)) return projDir;

  return process.cwd();
}

// ── Default report-output root ──────────────────────────────────────────
// SINGLE definition for "the project's default report root" — moved here
// (from index.ts) so security_scan/report.ts can reuse it without pulling
// in the whole CLI entrypoint module (a direct report.ts->index.ts edge
// would add one; this module has zero deps beyond node:fs/node:path).
// Every llm-ext report lands under
// `<project-root>/reports/llm-externalizer/[<subdir>]` — the write-roots
// rule's (2026-09-18) USER-approved exception to "only ~/.llm-externalizer/
// + plugin/plugin-data".
//
// Resolution order (highest precedence first):
//   1. `mainRootOverride` param — an explicit caller-resolved root (e.g. a
//      test's injected mainRoot, or security_scan's `deps.mainRoot`).
//      Bypasses the cache AND the LLM_EXT_OUTPUT_DIR env check, same as
//      resolveProjectMainRoot's own `override` — an explicit value always
//      wins over environment/cache.
//   2. LLM_EXT_OUTPUT_DIR — explicit env override; absolute path wins all.
//   3. `<resolveProjectMainRoot()>/reports/llm-externalizer/` — CLAUDE_PROJECT_DIR
//      verbatim → cwd, NO git (see resolveProjectMainRoot's own doc above).
//      Cached after the first lookup (only when no override was given).
//
// A per-call explicit `output_dir` (handled by each caller, not here) still
// overrides everything above unconditionally.

let _cachedDefaultOutputDir: string | undefined;

export function defaultOutputDir(mainRootOverride?: string): string {
  if (mainRootOverride && mainRootOverride.length > 0) {
    return join(mainRootOverride, "reports", "llm-externalizer");
  }
  if (_cachedDefaultOutputDir) return _cachedDefaultOutputDir;
  const envOverride = process.env.LLM_EXT_OUTPUT_DIR;
  if (envOverride && envOverride.trim()) {
    _cachedDefaultOutputDir = resolve(envOverride.trim());
    return _cachedDefaultOutputDir;
  }
  _cachedDefaultOutputDir = join(resolveProjectMainRoot(), "reports", "llm-externalizer");
  return _cachedDefaultOutputDir;
}


// ── Default scratch-output root (TRDD-PNU8XECB) ─────────────────────────
// USER directive 2026-11-15: `reports/` is git-tracked and holds only FINAL,
// complete or merged reports; `reports_dev/` is gitignored and holds
// intermediate artifacts — per-file pieces that a run later merges, partial
// runs, and llm-ext's own model-pool benchmark/health output (tool
// configuration, which the reports rule routes to reports_dev even when it is
// complete). This resolver is the single source for that second root.
//
// Resolution order (highest precedence first):
//   1. `mainRootOverride` — explicit caller root, same bypass as
//      defaultOutputDir: `<override>/reports_dev/llm-externalizer`.
//   2. LLM_EXT_SCRATCH_DIR — relocates ONLY the scratch output.
//   3. LLM_EXT_OUTPUT_DIR — WHY it applies here too: a caller (a test, a
//      worker, a CI job) that sets it is isolating llm-ext's writes; routing
//      scratch to `<project>/reports_dev` anyway would leak those writes into
//      the real project. So an output-dir override keeps EVERYTHING in that one
//      dir, exactly as before this split.
//   4. `<resolveProjectMainRoot()>/reports_dev/llm-externalizer/` — cached.
//
// A per-call explicit `output_dir` (handled by each caller) still wins over all
// of this, pieces included: the user named the folder.

let _cachedDefaultScratchDir: string | undefined;

export function defaultScratchDir(mainRootOverride?: string): string {
  if (mainRootOverride && mainRootOverride.length > 0) {
    return join(mainRootOverride, "reports_dev", "llm-externalizer");
  }
  if (_cachedDefaultScratchDir) return _cachedDefaultScratchDir;
  const scratchEnv = process.env.LLM_EXT_SCRATCH_DIR?.trim();
  const outputEnv = process.env.LLM_EXT_OUTPUT_DIR?.trim();
  if (scratchEnv) {
    _cachedDefaultScratchDir = resolve(scratchEnv);
  } else if (outputEnv) {
    _cachedDefaultScratchDir = resolve(outputEnv);
  } else {
    _cachedDefaultScratchDir = join(resolveProjectMainRoot(), "reports_dev", "llm-externalizer");
  }
  return _cachedDefaultScratchDir;
}

/**
 * Directory for the per-file pieces of a multi-file run (TRDD-PNU8XECB).
 * `merging` is true when the run will merge the pieces into one or more
 * final reports (answer mode 1/2, or grouped output): the pieces are then
 * intermediate and go to the scratch root, and the merged report alone goes
 * to `reports/`. In mode 0 the per-file reports ARE the deliverable, so the
 * caller's dir is returned unchanged (undefined = defaultOutputDir()). An
 * explicit `outputDir` always wins. If a merge is skipped (some file failed),
 * the listed pieces stay in the scratch root — a partial run, which the
 * directive also assigns to reports_dev.
 */
export function mergePieceDir(outputDir: string | undefined, merging: boolean): string | undefined {
  if (outputDir) return outputDir;
  return merging ? defaultScratchDir() : undefined;
}

/** Test-only: reset the cached default so a test that sets
 *  CLAUDE_PROJECT_DIR / LLM_EXT_OUTPUT_DIR mid-run gets the recomputed value. */
export function _resetDefaultOutputDirCache(): void {
  _cachedDefaultOutputDir = undefined;
  // WHY both: tests that reset the output cache also change the env the
  // scratch root derives from (TRDD-PNU8XECB); a stale scratch cache would
  // send pieces to a previous test's directory.
  _cachedDefaultScratchDir = undefined;
}

/** Test-only re-export of the internal helper so default-output-dir.test.ts
 *  can verify the env-override / git-root / fallback chain without
 *  importing the full CLI entrypoint (index.ts) — the MCP server this
 *  comment used to name was removed and MCP is now banned outright for
 *  this project (llm-ext is CLI-only). */
export function _testDefaultOutputDir(): string {
  return defaultOutputDir();
}
