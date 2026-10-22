import { join } from "node:path";

import { defaultOutputDir } from "../project-root.js";

/**
 * Default report directory for a benchmark sub-command: `<project-root>/reports/
 * llm-externalizer/<sub>/`, via defaultOutputDir() — the ONLY USER-approved
 * report root outside ~/.llm-externalizer (write-roots rule, 2026-09-18).
 *
 * Every scan-folder/code-task/search-existing/security-triage/check-specs/
 * text-tools benchmark used to hand-roll `join(mainRoot, "reports", "<sub>")`
 * instead — landing straight in `<project-root>/reports/<sub>/`, OUTSIDE every
 * approved write root. One shared, tested helper instead of six copies of the
 * same bug (CLAUDE.md: fix the root cause where all callers route through, not
 * per-caller). Callers keep `opts.outputDir ?? benchmarkSubReportDir(...)` at
 * the call site — an explicit outputDir always wins and is untouched here.
 */
export function benchmarkSubReportDir(sub: string, mainRoot?: string): string {
  return join(defaultOutputDir(mainRoot), sub);
}
