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

export function resolveProjectMainRoot(override?: string): string {
  if (override && override.length > 0) return override;

  const projDir = process.env.CLAUDE_PROJECT_DIR;
  if (projDir && projDir.length > 0 && existsSync(projDir)) return projDir;

  return process.cwd();
}
