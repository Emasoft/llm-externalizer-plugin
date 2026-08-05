/**
 * review_plan — the $0 delegate mode (TRDD-SNAEERHU, distilled from
 * OpenCodeReview's delegate concept; adapted, never vendored — OCR is Go).
 *
 * The tool emits the DETERMINISTIC scaffolding of a code review — resolved
 * file set, per-file framing, the review rubric — and the HOST agent (Claude
 * Code on its own subscription, or any LLM the caller drives) performs the
 * actual reviewing. No LLM call, no network, no API key: measured on the
 * planted-ground-truth range (reports/open-code-review-eval/
 * 20260805_005500+0200-final-trusted-results.md), the host-agent workflow was
 * the ONLY configuration that found the planted bug — at $0 — while the
 * driven-LLM configurations found nothing at up to $0.55/run.
 *
 * Pure module: the dispatch layer resolves files (same walker as scan_folder —
 * an estimate/plan over a different file set than a run would use is worse
 * than none) and passes them in; this builds the plan text. Auto-DUBC: works
 * with zero configuration; the rubric is overridable per call (and will pick
 * up the layered rules engine, TRDD-3JQVBO7M, when that lands).
 */

export interface ReviewPlanFile {
  path: string;
  bytes: number;
}

export interface ReviewPlanOptions {
  /** Override the default rubric (e.g. from --instructions). Appended-to, never silently replaced. */
  instructions?: string;
  /** Where the host agent should write its report (advisory line in the plan). */
  reportDir?: string;
  /**
   * Diff mode (TRDD-MNK2YNH0): per-file unified-diff hunks (with git's
   * enclosing-function context). When present, the plan embeds them so the
   * host agent reviews the CHANGES and opens full files only when needed.
   */
  hunksByFile?: ReadonlyMap<string, string>;
}

/**
 * The built-in rubric — the same real-defects-only contract the scan skill
 * documents. Kept here as the ONE authoritative copy for delegate mode.
 */
export const DEFAULT_REVIEW_RUBRIC =
  "Report ONLY real defects: wrong logic or inverted conditions, crashes, data " +
  "corruption, race conditions, security exploits, broken local references, and " +
  "misleading data persisted to ledgers/reports. Do NOT report style, naming, " +
  "missing error handling (fail-fast projects propagate errors deliberately), " +
  "null checks a strict type-checker already covers, or hypothetical hardening. " +
  "Cite exact function names and line numbers that exist. Rank findings by " +
  "severity (critical/high/medium/low) and state a concrete failure scenario " +
  "for each — a finding without a failure scenario is not a finding.";

/** One review plan, as plain greppable markdown — no UI, no color. */
export function buildReviewPlan(
  files: ReviewPlanFile[],
  opts: ReviewPlanOptions = {},
): string {
  if (files.length === 0) {
    // Fail-fast contract is the CALLER's (dispatch returns isError on resolver
    // failure); an empty list reaching here is a caller bug worth being loud about.
    throw new Error("review_plan: no files to plan — caller must fail before this point");
  }
  const totalBytes = files.reduce((a, f) => a + f.bytes, 0);
  const lines: string[] = [];
  lines.push("# REVIEW PLAN (delegate mode — no LLM was called, $0)");
  lines.push("");
  lines.push(
    `${files.length} file(s), ${totalBytes.toLocaleString()} bytes total. ` +
      "YOU (the host agent) are the reviewer: read each file, apply the rubric, " +
      "report findings. This tool only planned the work.",
  );
  lines.push("");
  lines.push("## Rubric");
  lines.push("");
  lines.push(DEFAULT_REVIEW_RUBRIC);
  if (opts.instructions && opts.instructions.trim().length > 0) {
    lines.push("");
    lines.push("Additional caller instructions (append to, do not replace, the rubric):");
    lines.push(opts.instructions.trim());
  }
  lines.push("");
  lines.push("## Files (review each, largest last so context-heavy work comes warm)");
  lines.push("");
  const sorted = [...files].sort((a, b) => a.bytes - b.bytes);
  for (const f of sorted) {
    lines.push(`- ${f.path} (${f.bytes.toLocaleString()} B)`);
  }
  if (opts.hunksByFile && opts.hunksByFile.size > 0) {
    lines.push("");
    lines.push("## Changed hunks (diff mode — review THESE; open full files only when a hunk demands it)");
    for (const f of sorted) {
      const hunk = opts.hunksByFile.get(f.path);
      if (!hunk) continue;
      lines.push("");
      lines.push(`### ${f.path}`);
      lines.push("```diff");
      lines.push(hunk);
      lines.push("```");
    }
  }
  lines.push("");
  lines.push("## Protocol");
  lines.push("");
  lines.push("1. Read each file IN FULL before judging it (no hunk-blind claims).");
  lines.push(
    "2. For every candidate finding, verify against the actual code before " +
      "reporting — a claim refutable by reading three lines of context is worse " +
      "than no claim.",
  );
  lines.push(
    "3. Write the findings report to " +
      (opts.reportDir ?? "<main-project>/reports/llm-externalizer/") +
      " with a local-time+offset timestamped filename; reply with the report " +
      "path and a one-line verdict count.",
  );
  return lines.join("\n");
}
