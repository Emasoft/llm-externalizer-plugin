/**
 * Deterministic scorer for the search_existing_implementations benchmark
 * (TRDD-828238b5 A6). The tool's output is a per-file binary verdict
 * (NO / one-or-more "YES symbol=… lines=…" lines), so — unlike the free-form
 * review tools — it can be scored mechanically against the golden dataset:
 * precision/recall/F1 over the YES set, no LLM judge involved.
 *
 * Section extraction is NOT re-implemented here: the runner splits batch
 * responses with the pipeline's own splitPerFileSections (grouping.ts); this
 * module only classifies an already-extracted section body and does the math.
 */

export type SectionVerdict = "yes" | "no" | "unparseable";

/**
 * Classify one per-file section body emitted by the pipeline's prompt
 * contract: any line beginning with YES is a match; "NO" (including
 * "NO (self-reference)") is a non-match; anything else is unparseable.
 * A section containing both YES and NO lines counts as yes — the prompt
 * allows multiple findings per file and YES lines dominate.
 */
export function parseSectionVerdict(body: string): SectionVerdict {
  let sawNo = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line === "---") continue;
    if (/^YES\b/.test(line)) return "yes";
    if (/^NO\b/.test(line)) {
      sawNo = true;
      continue;
    }
  }
  return sawNo ? "no" : "unparseable";
}

export interface CaseScore {
  caseId: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  /** Scanned files whose section was missing or unparseable. */
  unscored: number;
  scannedFiles: number;
  precision: number;
  recall: number;
  f1: number;
}

function safePrecision(tp: number, fp: number): number {
  return tp + fp === 0 ? 1 : tp / (tp + fp);
}

function safeRecall(tp: number, fn: number): number {
  return tp + fn === 0 ? 1 : tp / (tp + fn);
}

function f1Of(precision: number, recall: number): number {
  return precision + recall === 0
    ? 0
    : (2 * precision * recall) / (precision + recall);
}

/**
 * Score one dataset case. `expectedYes` and the `verdicts` keys must use the
 * SAME path form (the runner uses absolute fixture paths for both).
 * A missing/unparseable verdict on an expected-YES file is a false negative;
 * on an expected-NO file it is tracked as unscored (not a false positive —
 * the model did not assert a match) but degrades the coverage threshold.
 */
export function scoreCase(
  caseId: string,
  scannedFiles: readonly string[],
  expectedYes: ReadonlySet<string>,
  verdicts: ReadonlyMap<string, SectionVerdict>,
): CaseScore {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let unscored = 0;
  for (const file of scannedFiles) {
    const verdict = verdicts.get(file);
    const expectYes = expectedYes.has(file);
    if (verdict === "yes") {
      if (expectYes) tp++;
      else fp++;
    } else if (verdict === "no") {
      if (expectYes) fn++;
      else tn++;
    } else {
      unscored++;
      if (expectYes) fn++;
    }
  }
  const precision = safePrecision(tp, fp);
  const recall = safeRecall(tp, fn);
  return {
    caseId,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    unscored,
    scannedFiles: scannedFiles.length,
    precision,
    recall,
    f1: f1Of(precision, recall),
  };
}

export interface SearchExistingScore {
  cases: CaseScore[];
  /** Micro-averaged over the pooled confusion counts of every case. */
  microPrecision: number;
  microRecall: number;
  microF1: number;
  /** Unweighted mean of the per-case F1s. */
  macroF1: number;
  /** Fraction of scanned files that received a parseable verdict. */
  coverage: number;
}

export function aggregateScores(cases: readonly CaseScore[]): SearchExistingScore {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let unscored = 0;
  let scanned = 0;
  for (const c of cases) {
    tp += c.truePositives;
    fp += c.falsePositives;
    fn += c.falseNegatives;
    unscored += c.unscored;
    scanned += c.scannedFiles;
  }
  const microPrecision = safePrecision(tp, fp);
  const microRecall = safeRecall(tp, fn);
  return {
    cases: [...cases],
    microPrecision,
    microRecall,
    microF1: f1Of(microPrecision, microRecall),
    macroF1:
      cases.length === 0
        ? 0
        : cases.reduce((sum, c) => sum + c.f1, 0) / cases.length,
    coverage: scanned === 0 ? 0 : (scanned - unscored) / scanned,
  };
}

export interface SearchExistingThresholds {
  minMicroF1: number;
  minMicroRecall: number;
  minCoverage: number;
}

/**
 * Pass bar mirroring security-triage's posture: recall is weighted via its
 * own floor because a missed duplicate (the reviewer deletes nothing) costs
 * more than a spurious one (the reviewer glances and moves on).
 */
export const DEFAULT_SEARCH_EXISTING_THRESHOLDS: SearchExistingThresholds = {
  minMicroF1: 0.85,
  minMicroRecall: 0.85,
  minCoverage: 0.9,
};

export function passesThresholds(
  score: SearchExistingScore,
  thresholds: SearchExistingThresholds = DEFAULT_SEARCH_EXISTING_THRESHOLDS,
): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  if (score.microF1 < thresholds.minMicroF1) {
    failures.push(
      `micro-F1 ${score.microF1.toFixed(3)} < ${thresholds.minMicroF1}`,
    );
  }
  if (score.microRecall < thresholds.minMicroRecall) {
    failures.push(
      `micro-recall ${score.microRecall.toFixed(3)} < ${thresholds.minMicroRecall}`,
    );
  }
  if (score.coverage < thresholds.minCoverage) {
    failures.push(
      `coverage ${score.coverage.toFixed(3)} < ${thresholds.minCoverage}`,
    );
  }
  return { pass: failures.length === 0, failures };
}
