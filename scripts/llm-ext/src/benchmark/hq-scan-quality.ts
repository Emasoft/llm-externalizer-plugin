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
import { aggregateScores, type CaseScore } from "./search-existing/score.js";
import { hqScanQualityHash, recordFitnessVerdict } from "./free-fitness-ledger.js";
import { assertPaidBenchmarkAllowed, type OpenRouterModel } from "./discover.js";

/** One model the --hq-scan-quality CLI phase will run, with the catalog price the cost guard judged. */
export interface HqScanQualityRosterEntry {
  id: string;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
  pricing: ModelPricing;
}

/** One message for the empty-roster refusal, shared by index.ts validateCombinations
 *  and resolveHqScanQualityRoster so the two can never drift apart. */
export const HQ_EMPTY_ROSTER_ERROR =
  "--hq-scan-quality needs at least one model id (or --bench-free-pool): it has no auto-discovery.";

/**
 * Should the --hq-scan-quality phase STOP before running the next model?
 * Returns the refusal reason, or null to proceed.
 *
 * WHY per model, before the call: the phase runs models one after another, so
 * the only point where money can still be saved is before each model starts.
 * `estimateUsd` is the worst case for one full scan_folder sweep
 * (update-all.ts estimateWorkloadCostUsd over scan-folder describeWorkload: every
 * call emits its full max_tokens), compared against
 *   - what is left of this run's --budget-usd (`budgetUsd - spentRunUsd`), and
 *   - what is left of today's paid_benchmark_daily_cap_usd (daily-spend.ts
 *     dailyRemainingUsd, which fails CLOSED to 0 on a corrupt ledger).
 * A $0 estimate (a :free or $0-priced id) never moves either ledger, so it always runs.
 */
export function hqSpendRefusal(
  estimateUsd: number,
  spentRunUsd: number,
  budgetUsd: number,
  dailyRemainingUsd: number,
): string | null {
  if (estimateUsd === 0) return null;
  const runLeft = budgetUsd - spentRunUsd;
  if (estimateUsd > runLeft) {
    return `worst-case estimate $${estimateUsd.toFixed(4)} exceeds the $${Math.max(0, runLeft).toFixed(4)} left of --budget-usd $${budgetUsd.toFixed(2)}`;
  }
  if (estimateUsd > dailyRemainingUsd) {
    return `worst-case estimate $${estimateUsd.toFixed(4)} exceeds the $${dailyRemainingUsd.toFixed(4)} left of today's paid_benchmark_daily_cap_usd`;
  }
  return null;
}

/**
 * Resolve the explicit --hq-scan-quality model ids against the catalog and apply
 * the SAME paid-benchmark cost guard every other per-tool benchmark applies
 * (assertPaidBenchmarkAllowed): a :free or $0-priced id runs free, a billable id
 * needs --allow-paid-models-tests (and the allow_paid_models master switch).
 *
 * WHY a separate pure function: runHqScanQualityBenchmark itself deliberately has
 * no paid gate (its caller chooses the candidate), so the CLI caller IS the gate —
 * and the decision must be unit-testable with no network (the catalog is passed in).
 *
 * WHY every id must be in the catalog with a finite price and a positive context
 * length (even a :free id): a guessed price would let an unpriced paid model past
 * the guard and turn the run spend into Infinity, and a 0 context window would be
 * handed to the runner as a real sizing input. Refusing is the only honest
 * answer when the facts the guard and the runner need are missing.
 */
export function resolveHqScanQualityRoster(
  modelIds: readonly string[],
  catalog: readonly OpenRouterModel[],
): HqScanQualityRosterEntry[] {
  if (modelIds.length === 0) {
    throw new Error(HQ_EMPTY_ROSTER_ERROR);
  }
  const byId = new Map(catalog.map((m) => [m.id, m] as const));
  const roster: HqScanQualityRosterEntry[] = [];
  for (const id of modelIds) {
    const raw = byId.get(id);
    if (raw === undefined) {
      throw new Error(`--hq-scan-quality: model ${id} is not in the OpenRouter catalog, so its price and context window are unknown — refusing (no API call made, $0 spent).`);
    }
    const p = parseFloat(raw.pricing?.prompt ?? "NaN");
    const c = parseFloat(raw.pricing?.completion ?? "NaN");
    if (!Number.isFinite(p) || !Number.isFinite(c)) {
      throw new Error(`--hq-scan-quality: catalog price of ${id} is missing or invalid — refusing (no API call made, $0 spent).`);
    }
    const ctx = raw.context_length ?? 0;
    if (!(ctx > 0)) {
      throw new Error(`--hq-scan-quality: catalog context window of ${id} is missing or 0 — refusing (no API call made, $0 spent).`);
    }
    const input = p * 1_000_000;
    const output = c * 1_000_000;
    roster.push({
      id,
      inputDollarsPerMillion: input,
      outputDollarsPerMillion: output,
      pricing: { input_per_m_usd: input, output_per_m_usd: output, context_window: ctx },
    });
  }
  assertPaidBenchmarkAllowed(roster.map((r) => ({ id: r.id, inputDollarsPerMillion: r.inputDollarsPerMillion, outputDollarsPerMillion: r.outputDollarsPerMillion })));
  return roster;
}

/**
 * Is a bench-runner failure reason a TRANSIENT provider failure (no answer, and
 * a retry could plausibly get one) rather than a fact about the model? Matches
 * the exact strings scan-folder/bench-runner.ts processFileCheck writes:
 *   "request failed: <msg>"   a thrown fetch — transient, EXCEPT a timeout
 *                              (AbortSignal.timeout): a model too slow for the
 *                              per-call budget is a property of the model;
 *   "API error <status>: …"   transient only for 408, 429 and 5xx — any other
 *                              4xx (bad request, context overflow, not found)
 *                              is a refusal about this model/request;
 *   "malformed response body" a truncated/garbled 200 — transient.
 * The hq-scan-quality.test.ts tests drive the REAL bench-runner to produce these
 * strings, so a wording change there fails a test instead of silently flipping
 * outages back into FAIL verdicts.
 */
export function isTransientFailureReason(reason: string): boolean {
  if (reason.startsWith("request failed:")) return !/timeout|timed out/i.test(reason);
  const api = /^API error (\d{3}):/.exec(reason);
  if (api) {
    const status = Number(api[1]);
    return status === 408 || status === 429 || (status >= 500 && status <= 599);
  }
  return reason.startsWith("malformed response body");
}

/**
 * Best case: could the run clear the scan_folder bar if every transient-failed
 * file had been answered CORRECTLY? Each such file is unscored today; answered
 * correctly it becomes scored, and if it was an expected match it also turns one
 * false negative into a true positive. Per-file truth is not carried in
 * `failures`, so the bound is optimistic: up to k of a case's false negatives
 * flip to true positives for k transient failures in that case. Optimistic is
 * the safe direction here — it can only make a run inconclusive, never PASS.
 */
export function couldPassIfAnswered(
  caseScores: readonly CaseScore[],
  transientFailures: readonly { caseId: string }[],
): boolean {
  const perCase = new Map<string, number>();
  for (const f of transientFailures) perCase.set(f.caseId, (perCase.get(f.caseId) ?? 0) + 1);
  const best: CaseScore[] = caseScores.map((c) => {
    const k = Math.min(perCase.get(c.caseId) ?? 0, c.unscored);
    const flipped = Math.min(k, c.falseNegatives);
    return {
      ...c,
      truePositives: c.truePositives + flipped,
      falseNegatives: c.falseNegatives - flipped,
      unscored: c.unscored - k,
    };
  });
  return passesThresholds(aggregateScores(best), DEFAULT_SCAN_FOLDER_THRESHOLDS).pass;
}

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
  // WHY a TRANSIENT failure can make a non-pass INCONCLUSIVE (TRDD-FUHTNE04): the
  // scan-folder bench-runner never throws on a per-file provider problem — it
  // degrades it into a `failures` entry (bench-runner.ts processFileCheck) and the
  // unscored file then costs coverage/recall. Recording that as FAIL would write a
  // provider outage into the ledger as a quality verdict about the model.
  // Two limits keep this from hiding real failures:
  //   - only transient reasons count (isTransientFailureReason: network error,
  //     408/429/5xx, malformed body) — a timeout, a 4xx such as context overflow,
  //     or an empty reply are facts about the model and still score as FAIL;
  //   - the run is inconclusive only if the transient files COULD have changed the
  //     verdict: with every one of them counted as a correct answer
  //     (couldPassIfAnswered), the bar must be clearable. A model that fails the
  //     bar even in that best case is a conclusive FAIL.
  // A PASS despite transient failures stays a pass (the bar was cleared anyway).
  const transientFailures = run.failures.filter((f) => isTransientFailureReason(f.reason));
  const inconclusive =
    !verdict.pass && transientFailures.length > 0 && couldPassIfAnswered(run.caseScores, transientFailures);
  const label = verdict.pass ? "PASS" : inconclusive ? "INCONCLUSIVE" : "FAIL";
  const result: HqScanQualityResult = {
    modelId,
    pass: verdict.pass,
    inconclusive,
    microF1: run.aggregate.microF1,
    microRecall: run.aggregate.microRecall,
    microPrecision: run.aggregate.microPrecision,
    coverage: run.aggregate.coverage,
    failures: run.failures,
    costUsd: run.costUsd,
    summaryLine:
      `hq-scan quality ${label} — ` +
      `microF1=${run.aggregate.microF1.toFixed(3)} ` +
      `microR=${run.aggregate.microRecall.toFixed(3)} ` +
      `cov=${run.aggregate.coverage.toFixed(3)}` +
      (verdict.failures.length > 0 ? ` — ${verdict.failures.join("; ")}` : "") +
      (inconclusive ? ` — ${transientFailures.length} transient provider failure(s), e.g. ${transientFailures[0]!.reason.slice(0, 120)}` : ""),
  };
  progress(result.summaryLine);
  // An inconclusive row is recorded as {pass:false, inconclusive:true}: the
  // ledger readers (passedFitnessModelIds, verdicts.ts judgeScoreRow) treat it as
  // neither pass nor fail, so it never stands as a fail verdict.
  recordFitnessVerdict(
    "high_quality_scan",
    modelId,
    hqScanQualityHash(opts.datasetHash),
    { pass: result.pass, inconclusive },
    result.summaryLine,
  );
  return result;
}

/** Outcome of one --hq-scan-quality roster run. `stopped` is set when the spend
 *  gate refused a model; `notRun` then lists it and every model after it. */
export interface HqScanQualityRosterOutcome {
  results: { id: string; label: "pass" | "fail" | "inconclusive"; costUsd: number }[];
  spendUsd: number;
  stopped?: { beforeId: string; reason: string; notRun: string[] };
}

/**
 * The --hq-scan-quality phase loop, with every side effect injected so the stop
 * path, the per-model booking and the $0 shortcut are unit-testable with no
 * network or ledger (index.ts runHqScanQualityPhase supplies the real ones).
 *
 * WHY the daily remainder is asked only for a priced model: a $0 model can never
 * move the daily ledger, and dailyRemainingUsd fails CLOSED to 0 on a corrupt
 * ledger — consulting it for a free model would let a corrupt paid-spend file
 * block free benchmarking for no money reason.
 * WHY book after each model: the next model's daily check (and any concurrent
 * process) must see this model's real spend. Nothing else books for this phase —
 * runHqScanQualityBenchmark and the scan-folder bench-runner never call
 * bookDailySpend — so this is the single booking point.
 */
export async function runHqScanQualityRoster(
  roster: readonly HqScanQualityRosterEntry[],
  deps: {
    budgetUsd: number;
    estimateUsd: (entry: HqScanQualityRosterEntry) => number;
    dailyRemainingUsd: () => number;
    bookSpend: (usd: number) => void;
    run: (entry: HqScanQualityRosterEntry) => Promise<HqScanQualityResult>;
  },
): Promise<HqScanQualityRosterOutcome> {
  const results: HqScanQualityRosterOutcome["results"] = [];
  let spendUsd = 0;
  for (let i = 0; i < roster.length; i++) {
    const entry = roster[i]!;
    const estimate = deps.estimateUsd(entry);
    const daily = estimate === 0 ? Infinity : deps.dailyRemainingUsd();
    const reason = hqSpendRefusal(estimate, spendUsd, deps.budgetUsd, daily);
    if (reason !== null) {
      return { results, spendUsd, stopped: { beforeId: entry.id, reason, notRun: roster.slice(i).map((e) => e.id) } };
    }
    const r = await deps.run(entry);
    deps.bookSpend(r.costUsd);
    spendUsd += r.costUsd;
    results.push({ id: entry.id, label: r.pass ? "pass" : r.inconclusive ? "inconclusive" : "fail", costUsd: r.costUsd });
  }
  return { results, spendUsd };
}
