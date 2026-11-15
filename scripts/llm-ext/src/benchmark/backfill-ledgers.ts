/**
 * Standalone, zero-network backfill across all five benchmark ledgers.
 * Each tool's `backfillOwnLedger()` already gates on its own datasetHash and
 * predicate (see backfill-quality-pass.ts) — this just fans out to all five
 * and keeps one failing tool from aborting the rest.
 */

import { backfillOwnLedger as backfillCodeTask } from "./code-task/index.js";
import { backfillOwnLedger as backfillScanFolder } from "./scan-folder/index.js";
import { backfillOwnLedger as backfillCheckSpecs } from "./check-specs/index.js";
import { backfillOwnLedger as backfillSearchExisting } from "./search-existing/index.js";
import { backfillOwnLedger as backfillSecurityTriage } from "./security-triage/index.js";
import { getConfigDir } from "../config.js";

export function backfillAllLedgers(): { tool: string; upgraded: number }[] {
  const runners: { tool: string; run: () => { tool: string; upgraded: number } }[] = [
    { tool: "code_task", run: backfillCodeTask },
    { tool: "scan_folder", run: backfillScanFolder },
    { tool: "check_against_specs", run: backfillCheckSpecs },
    { tool: "search_existing_implementations", run: backfillSearchExisting },
    { tool: "security_scan", run: backfillSecurityTriage },
  ];
  return runners.map(({ tool, run }) => {
    try {
      return run();
    } catch (e) {
      // One tool's dataset/cache being broken must not stop the others.
      return { tool: `${tool} (failed: ${(e as Error).message})`, upgraded: 0 };
    }
  });
}

// Config dirs already backfilled in this process. Keyed by dir, not a bare
// boolean: LLM_EXT_CONFIG_DIR can change at runtime (every test case swaps it),
// and a dir-blind guard would skip the backfill of the second dir.
const backfilledDirs = new Set<string>();

/**
 * Run backfillAllLedgers at most once per process per config dir. Called lazily
 * by every reader of the deterministic ledgers (validated.ts send gate,
 * profiles/production-verdicts.ts) before its first read. Each tool is isolated
 * (backfillAllLedgers catches per tool), so the gate it sits in never fails on it:
 * a tool that cannot backfill leaves its ledger as it was. A tool that failed is named once
 * on stderr, so a broken dataset is visible instead of silently unvalidating it.
 */
export function ensureLedgersBackfilled(): void {
  const dir = getConfigDir();
  if (backfilledDirs.has(dir)) return;
  backfilledDirs.add(dir);
  for (const r of backfillAllLedgers()) {
    if (r.tool.includes("(failed: ")) process.stderr.write(`llm-ext: legacy ledger backfill skipped for ${r.tool}\n`);
  }
}
