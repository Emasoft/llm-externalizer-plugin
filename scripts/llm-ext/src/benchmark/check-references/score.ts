/**
 * Deterministic scorer for the check_references benchmark (TRDD-2G6D42LK).
 *
 * The unit of truth is a per-case BINARY verdict: is this named import binding
 * broken? So this reuses search-existing/score.ts's matrix directly — the same
 * shape scan-folder scores — with one case per fixture.
 *
 * BOTH DIRECTIONS ARE GRADED HERE, unlike check-imports and compare-files.
 * Those score recall-only because their oracles cannot see everything a correct
 * answer might legitimately contain. This one can: a binding is broken or it is
 * not, and the corpus contains BOTH kinds. So a false positive is a real defect
 * — declaring an intact binding broken sends a developer chasing a reference
 * that is fine, and a tool that cries wolf is abandoned faster than one that
 * misses. Precision therefore gates, and the negative control in the dataset is
 * what makes that gate meaningful rather than decorative.
 */

import {
  aggregateScores,
  passesThresholds as sharedPassesThresholds,
  scoreCase,
  type CaseScore,
  type SearchExistingScore,
  type SearchExistingThresholds,
  type SectionVerdict,
} from "../search-existing/score.js";

export type CheckReferencesScore = SearchExistingScore;
export type CheckReferencesThresholds = SearchExistingThresholds;
export type { CaseScore };

/**
 * Score the whole corpus in one matrix: each fixture is one item, "yes" meaning
 * the model called the binding broken. `reported === null` is an unusable answer
 * and becomes unscored rather than a silent "not broken".
 */
export function scoreCorpus(
  results: ReadonlyArray<{ symbol: string; broken: boolean; reported: boolean | null }>,
): CaseScore {
  const items = results.map((r) => r.symbol);
  const expectedBroken = new Set(results.filter((r) => r.broken).map((r) => r.symbol));
  const verdicts = new Map<string, SectionVerdict>(
    results.map((r) => [
      r.symbol,
      r.reported === null ? "unparseable" : r.reported ? "yes" : "no",
    ]),
  );
  return scoreCase("check-references", items, expectedBroken, verdicts);
}

export function scoreAll(cases: readonly CaseScore[]): CheckReferencesScore {
  return aggregateScores(cases);
}

/**
 * Both halves gate, and the F1 floor is what enforces that.
 *
 * A MISSED break ships a broken reference. A FALSE break sends someone chasing a
 * healthy one. Neither dominates, so unlike the other two benchmarks this one
 * has no reason to disable precision — and disabling it would let a model pass
 * by calling everything broken, which the corpus's intact case exists to catch.
 */
export const DEFAULT_CHECK_REFERENCES_THRESHOLDS: CheckReferencesThresholds = {
  minMicroF1: 0.8,
  minMicroRecall: 0.8,
  minCoverage: 0.9,
};

export function passesThresholds(
  score: CheckReferencesScore,
  thresholds: CheckReferencesThresholds = DEFAULT_CHECK_REFERENCES_THRESHOLDS,
): { pass: boolean; failures: string[] } {
  return sharedPassesThresholds(score, thresholds);
}
