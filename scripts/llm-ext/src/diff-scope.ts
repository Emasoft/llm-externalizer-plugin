/**
 * Diff-mode review scoping (TRDD-MNK2YNH0 — distilled from OpenCodeReview's
 * workspace/range/commit modes, adapted, never vendored).
 *
 * llm-ext reviewed WHOLE FILES only; this module scopes a review to what
 * actually changed, with the resolution DELEGATED TO GIT (never a hand-rolled
 * diff): `git diff --name-only` for the file set, `git diff -- <file>` for the
 * per-file hunks. Three modes, mutually exclusive:
 *   • workspace          — staged + unstaged + untracked vs HEAD
 *   • from/to            — a ref range (merge-base semantics via `...`)
 *   • commit             — one commit vs its parent
 *
 * Crossplatform: child_process with argv arrays (no shell interpolation), so
 * paths with spaces and Windows/WSL survive. FAIL-FAST: not a git repo, or a
 * zero-file diff, is an explicit error — a review of nothing must say so, not
 * quietly review nothing.
 *
 * The hunk text is enriched with the ENCLOSING-FUNCTION heading via git's own
 * hunk-header detection (`@@ ... @@ <function line>` — git already computes it
 * per language with its xfuncname machinery), which beats both a tree-sitter
 * dependency (native build, per-language grammars) and a hand-rolled
 * brace-matcher (wrong often enough to mislead a reviewer). Honest limit:
 * git's heading is the nearest preceding function-ish line, not a parse.
 */

import { spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";

export type DiffMode =
  | { kind: "workspace" }
  | { kind: "range"; from: string; to: string }
  | { kind: "commit"; commit: string };

export interface DiffScope {
  mode: DiffMode;
  repoRoot: string;
  /** Absolute paths of changed files (binary files excluded). */
  files: string[];
  /** file (absolute) → its unified diff text (with function-context headers). */
  hunksByFile: Map<string, string>;
  /** Changed files NOT included, with why — visible, never silent. */
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Per-file hunk-size cap. A multi-megabyte hunk (a bundled dist/*.js, a
 * lockfile, generated code) reviews NOTHING and drowns everything else —
 * measured live: a workspace diff that swept tracked dist bundles produced a
 * 46 MB "plan". Skips are RECORDED (never silent) so the caller sees exactly
 * what fell out and can review it deliberately if they really mean to.
 */
export const MAX_HUNK_BYTES = 400_000;

/** A ref must look like a ref — never a flag, never empty. Fail-fast beats
 *  handing `--exec` to git. */
function assertSafeRef(ref: string, label: string): void {
  if (!ref || ref.startsWith("-") || /\s/.test(ref)) {
    throw new Error(`diff scope: invalid ${label} ref: '${ref}'`);
  }
}

function git(repoRoot: string, argv: string[], opts?: { allowStatus1?: boolean }): string {
  const r = spawnSync("git", argv, {
    cwd: repoRoot,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // `git diff --no-index` uses classic diff exit semantics: 1 = "differences
  // found" (the NORMAL case for a new untracked file), not an error. Callers
  // of that form opt in to accepting it.
  const ok = r.status === 0 || (opts?.allowStatus1 === true && r.status === 1);
  if (!ok) {
    const err = (r.stderr || "").trim().split("\n")[0] || `git ${argv[0]} failed`;
    throw new Error(`diff scope: ${err}`);
  }
  return r.stdout ?? "";
}

/** The repo root that owns `dir` — fail-fast when there is none. */
export function resolveRepoRoot(dir: string): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    encoding: "utf-8",
  });
  const out = (r.stdout ?? "").trim();
  if (r.status !== 0 || !out) {
    throw new Error(
      `diff scope: '${dir}' is not inside a git repository — diff modes need git`,
    );
  }
  return out;
}

/** Parse the caller's diff args into a mode, or null when none were passed
 *  (the tool then keeps its non-diff behavior). Mixing modes is an error. */
export function parseDiffMode(args: Record<string, unknown>): DiffMode | null {
  const workspace = args.diff_workspace === true;
  const from = typeof args.diff_from === "string" ? args.diff_from : "";
  const to = typeof args.diff_to === "string" ? args.diff_to : "";
  const commit = typeof args.diff_commit === "string" ? args.diff_commit : "";
  const picked = [workspace, Boolean(from || to), Boolean(commit)].filter(Boolean).length;
  if (picked === 0) return null;
  if (picked > 1) {
    throw new Error(
      "diff scope: pick ONE of diff_workspace, diff_from/diff_to, diff_commit",
    );
  }
  if (workspace) return { kind: "workspace" };
  if (commit) {
    assertSafeRef(commit, "diff_commit");
    return { kind: "commit", commit };
  }
  if (!from || !to) {
    throw new Error("diff scope: diff_from and diff_to must BOTH be given");
  }
  assertSafeRef(from, "diff_from");
  assertSafeRef(to, "diff_to");
  return { kind: "range", from, to };
}

/** The `git diff` selector argv for a mode (shared by name-only + hunks). */
function diffSelector(mode: DiffMode): string[] {
  switch (mode.kind) {
    case "workspace":
      // HEAD-relative: staged + unstaged in one pass. Untracked files are
      // appended separately below (git diff does not list them).
      return ["HEAD"];
    case "range":
      // `...` = merge-base semantics: what the branch ADDED, not what base
      // moved on to — the review-scope meaning of "from..to".
      return [`${mode.from}...${mode.to}`];
    case "commit":
      return [`${mode.commit}^`, mode.commit];
  }
}

/**
 * Resolve a diff mode into the changed-file set + per-file hunks. Binary
 * files are excluded (nothing reviewable in the hunk); a zero-file result
 * throws — the caller asked to review changes and there are none.
 */
export function resolveDiffScope(mode: DiffMode, dir: string): DiffScope {
  const repoRoot = resolveRepoRoot(dir);
  const sel = diffSelector(mode);

  const nameOnly = git(repoRoot, ["diff", "--name-only", "--diff-filter=d", ...sel])
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const untracked =
    mode.kind === "workspace"
      ? git(repoRoot, ["ls-files", "--others", "--exclude-standard"])
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
      : [];

  const rel = [...new Set([...nameOnly, ...untracked])];
  const hunksByFile = new Map<string, string>();
  const files: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const r of rel) {
    const abs = isAbsolute(r) ? r : resolve(join(repoRoot, r));
    // Per-file hunks with git's own enclosing-function headers. `--function-context`
    // widens each hunk to the whole enclosing function where git can find it.
    const hunk =
      untracked.includes(r)
        ? git(
            repoRoot,
            ["diff", "--no-index", "--function-context", "--", "/dev/null", r],
            { allowStatus1: true }, // 1 = differences found — the normal case here
          ).trim() || "(new untracked file)"
        : git(repoRoot, ["diff", "--function-context", ...sel, "--", r]).trim();
    if (/^Binary files /m.test(hunk)) {
      skipped.push({ path: abs, reason: "binary file" });
      continue;
    }
    if (Buffer.byteLength(hunk) > MAX_HUNK_BYTES) {
      skipped.push({
        path: abs,
        reason: `hunk over ${Math.round(MAX_HUNK_BYTES / 1000)}KB (bundled/generated?) — review it deliberately if you mean to`,
      });
      continue;
    }
    files.push(abs);
    hunksByFile.set(abs, hunk);
  }

  if (files.length === 0) {
    throw new Error(
      `diff scope: the ${mode.kind} diff contains no reviewable files` +
        (skipped.length > 0
          ? ` (${skipped.length} skipped: ${skipped.map((s) => s.reason).join("; ")})`
          : "") +
        " — nothing to review",
    );
  }
  return { mode, repoRoot, files, hunksByFile, skipped };
}
