/**
 * high_quality_scan QUALITY fitness benchmark (TRDD-HBCCFOUF part 2; addendum H).
 *
 * What high_quality_scan IS: scan_folder driven by ONE strong model
 * (index.ts's `case "high_quality_scan"` — useEnsemble: false, one model
 * override). So its "existing quality bar" is exactly the one the scan-folder
 * per-tool benchmark already enforces (DEFAULT_SCAN_FOLDER_THRESHOLDS:
 * micro-F1 >= 0.85, micro-recall >= 0.85 — a NO_MATCH-to-everything model
 * cannot pass — coverage >= 0.9), over the SAME golden corpus.
 *
 * The benchmark therefore drives the REAL scan-folder bench-runner
 * (bench-runner.ts::runScanFolderBenchmarkOnModel — the real pipeline, real
 * prompt, real deterministic scorer) and records the verdict in the
 * free-fitness ledger under the current-corpus hash. Nothing about the bar is
 * re-derived here: one definition, two importers — the same call scan-folder's
 * score.ts made of search-existing's math.
 *
 * Free-fitness framing: callers pass ':free' model ids (that is the pool whose
 * fitness is in question). No paid gate runs here — the caller chose the
 * candidate, and the free-fitness unlock reads only ':free'-suffixed passes.
 */

import type { FetchImpl } from "../security_scan/judge.js";
import type { ModelPricing } from "../mass_scouting/cost-estimate.js";
import { runScanFolderBenchmarkOnModel } from "./scan-folder/bench-runner.js";
import { SCAN_FOLDER_CASES } from "./scan-folder/dataset.js";
import { DEFAULT_SCAN_FOLDER_THRESHOLDS, passesThresholds } from "./scan-folder/score.js";
import { hqScanQualityHash, recordFitnessVerdict } from "./free-fitness-ledger.js";

export interface HqScanQualityResult {
  modelId: string;
  pass: boolean;
  inconclusive: boolean;
  /** The scan-folder aggregate the bar was applied to. */
  microF1: number;
  microRecall: number;
  microPrecision: number;
  coverage: number;
  failures: { caseId: string; file: string; reason: string }[];
  costUsd: number;
  summaryLine: string;
}

/**
 * Run ONE model over the scan-folder golden corpus with the REAL pipeline and
 * record its verdict against the tool's existing quality bar. `datasetHash`
 * is passed in by the orchestrating caller (the same fingerprint the ledger's
 * unlock computes), keeping one computation of the corpus hash per run.
 */
export async function runHqScanQualityBenchmark(
  modelId: string,
  opts: {
    apiKey: string;
    pricing?: ModelPricing;
    /** Test seam — injected HTTP impl forwarded to the bench-runner. */
    fetchImpl?: FetchImpl;
    perCallTimeoutMs?: number;
    datasetHash: string;
    onProgress?: (message: string) => void;
  },
): Promise<HqScanQualityResult> {
  const progress = opts.onProgress ?? ((): void => {});
  const pricing: ModelPricing = opts.pricing ?? {
    input_per_m_usd: 0,
    output_per_m_usd: 0,
    context_window: 0,
  };
  progress(`hq-scan quality: running ${modelId} over the scan-folder corpus…`);
  const run = await runScanFolderBenchmarkOnModel(
    modelId,
    SCAN_FOLDER_CASES,
    {
      apiKey: opts.apiKey,
      pricing,
      perCallTimeoutMs: opts.perCallTimeoutMs,
    },
    opts.fetchImpl,
  );
  const verdict = passesThresholds(run.aggregate, DEFAULT_SCAN_FOLDER_THRESHOLDS);
  const result: HqScanQualityResult = {
    modelId,
    pass: verdict.pass,
    inconclusive: false,
    microF1: run.aggregate.microF1,
    microRecall: run.aggregate.microRecall,
    microPrecision: run.aggregate.microPrecision,
    coverage: run.aggregate.coverage,
    failures: run.failures,
    costUsd: run.costUsd,
    summaryLine:
      `hq-scan quality ${verdict.pass ? "PASS" : "FAIL"} — ` +
      `microF1=${run.aggregate.microF1.toFixed(3)} ` +
      `microR=${run.aggregate.microRecall.toFixed(3)} ` +
      `cov=${run.aggregate.coverage.toFixed(3)}` +
      (verdict.failures.length > 0 ? ` — ${verdict.failures.join("; ")}` : ""),
  };
  progress(result.summaryLine);
  recordFitnessVerdict(
    "high_quality_scan",
    modelId,
    hqScanQualityHash(opts.datasetHash),
    { pass: result.pass, inconclusive: false },
    result.summaryLine,
  );
  return result;
}
