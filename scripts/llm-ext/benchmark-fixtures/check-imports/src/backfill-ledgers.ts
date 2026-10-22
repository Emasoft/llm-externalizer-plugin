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
