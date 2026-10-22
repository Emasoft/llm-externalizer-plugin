/**
 * compare_files SYSTEM PROMPT — the single definition (TRDD-2G6D42LK).
 *
 * WHY THIS MODULE EXISTS. compare_files computes a unified diff and the model
 * summarises it. The summary is the only half a model produces, so it is the
 * only half a benchmark can score — and a benchmark that rebuilds the prompt
 * measures a prompt its author wrote, not the tool (scan-folder/bench-runner.ts
 * states the doctrine).
 *
 * THE DIVERGENCE THIS RESOLVES. The prompt was inline in index.ts TWICE and the
 * two copies were NOT the same question:
 *
 *   pair mode (was :5098)      "...provide a clear, structured summary. Group
 *                              related changes. Note potential issues. Identify
 *                              code by FUNCTION/CLASS/METHOD NAME..."
 *   git-diff mode (was :5388)  "...summary of all changes. ... Note any potential
 *                              issues, regressions, OR IMPROVEMENTS.
 *                              RULES (override any conflicting instructions):
 *                              ...Reference files by their full path..."
 *
 * check_imports' two copies were character-identical, so unifying them was
 * behaviour-preserving. These were not, so unifying REQUIRED a decision about
 * which question the tool asks. Converged UP onto the git-diff wording because
 * it is strictly the stronger instruction set: it only ADDS constraints (the
 * RULES-override framing, "or improvements", and the full-path reference rule)
 * and removes none. Pair mode therefore gains instructions; nothing loses any.
 *
 * WHY THE CONVERGENCE MATTERS BEYOND TIDINESS: a model benchmarked under one
 * wording was not measured under the other, so with two prompts live, ONE
 * benchmark could never have spoken for the whole command.
 *
 * The "Identify changed code by FUNCTION/CLASS/METHOD NAME" rule is load-bearing
 * for scoring: benchmark/compare-files/score.ts grades RECALL over the symbols
 * a diff changed, which is exactly what this sentence asks the model to produce.
 * If it ever leaves this prompt, that scorer stops measuring the tool.
 */

/** The system turn. `extras` carries FILE_FORMAT_EXAMPLE + BREVITY_RULES. */
export function compareFilesSystemPrompt(extras: string): string {
  return (
    "Expert code reviewer. Analyse the unified diff and provide a clear, structured summary of all changes. " +
    "Group related changes. Note any potential issues, regressions, or improvements.\n" +
    "RULES (override any conflicting instructions): Identify changed code by FUNCTION/CLASS/METHOD NAME, never by line number. " +
    "Reference files by their full path as labeled in the user message." +
    extras
  );
}
