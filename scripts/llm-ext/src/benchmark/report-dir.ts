import { join } from "node:path";

import { defaultScratchDir } from "../project-root.js";

/**
 * Default report directory for a benchmark sub-command:
 * `<project-root>/reports_dev/llm-externalizer/<sub>/`, via defaultScratchDir().
 *
 * TRDD-PNU8XECB (USER directive 2026-11-15): a benchmark of llm-ext's own model
 * pool is tool configuration and is often run automatically (detached
 * populate/detector children), so it is not a final user report: it belongs
 * in the gitignored reports_dev/, never the git-tracked reports/. An
 * LLM_EXT_OUTPUT_DIR / LLM_EXT_SCRATCH_DIR override still relocates it (see
 * defaultScratchDir).
 *
 * One shared, tested helper instead of six hand-rolled `join(mainRoot, ...)`
 * copies. Callers keep `opts.outputDir ?? benchmarkSubReportDir(...)` at the
 * call site — an explicit outputDir always wins and is untouched here.
 */
export function benchmarkSubReportDir(sub: string, mainRoot?: string): string {
  return join(defaultScratchDir(mainRoot), sub);
}
