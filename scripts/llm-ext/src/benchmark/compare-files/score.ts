/**
 * Deterministic scorer for the compare_files benchmark (TRDD-2G6D42LK).
 *
 * ZERO LLM JUDGE. The unit of truth is a SET of top-level symbols the diff
 * changed; the model's summary either names them or does not.
 *
 * MATH REUSED, NOT REIMPLEMENTED — scoreCase/aggregateScores come from
 * search-existing/score.ts, exactly as scan-folder and check-imports import
 * them. The universe is (true ∪ mentioned) per diff, so TP/FP/FN are the same
 * counts, and TRUE NEGATIVES ARE ALWAYS ZERO here for the same reason they are
 * in check-imports: there is no finite population of "correctly did not mention
 * a symbol that never changed".
 *
 * RECALL-ONLY, and here the argument is even stronger than in check-imports.
 * There, extra paths were merely unknowable to the oracle. Here, prose that
 * names something outside the truth set is often GOOD WRITING: a summary that
 * says "renamed the three backfill helpers" or "tightened the 403 classifier"
 * is describing the change correctly at a higher altitude. Gating on precision
 * would systematically prefer a summary that robotically lists identifiers over
 * one a human would rather read.
 *
 * So: a MISSED symbol is a real defect (the summary omitted something that
 * demonstrably changed); an extra mention is reported and never punished.
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

export type CompareFilesScore = SearchExistingScore;
export type CompareFilesThresholds = SearchExistingThresholds;
export type { CaseScore };

/**
 * Does the summary mention this symbol?
 *
 * WORD-BOUNDARY matching, deliberately. A substring test would count "score"
 * as mentioning "scoreFile", so a summary discussing an unrelated symbol would
 * be credited for one it never named — inflating recall, the ONE metric that
 * gates here. Case-sensitive: these are identifiers, and `TRUTH` and `truth`
 * are different symbols in the corpus.
 */
export function mentions(summary: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`).test(summary);
}

/**
 * Score ONE diff. `summary === null` means the model produced nothing usable —
 * every true symbol becomes unscored rather than a silent zero, so coverage
 * surfaces a broken model separately from an inaccurate one.
 */
export function scoreDiff(
  id: string,
  changedSymbols: readonly string[],
  summary: string | null,
): CaseScore {
  const truth = new Set(changedSymbols);
  const universe = [...truth];
  const verdicts = new Map<string, SectionVerdict>(
    universe.map((sym) => [
      sym,
      summary === null ? "unparseable" : mentions(summary, sym) ? "yes" : "no",
    ]),
  );
  return scoreCase(id, universe, truth, verdicts);
}

/** Symbols the summary names that the diff did not change. Reported, NOT gated. */
export function hallucinatedSymbols(
  summary: string,
  changedSymbols: readonly string[],
  candidatePool: readonly string[],
): string[] {
  const truth = new Set(changedSymbols);
  return candidatePool.filter((s) => !truth.has(s) && mentions(summary, s));
}

export function scoreAll(cases: readonly CaseScore[]): CompareFilesScore {
  return aggregateScores(cases);
}

/**
 * Recall bar set BELOW check-imports' 0.95, and the difference is deliberate.
 * Extracting an import is mechanical — the answer is literally in the text — so
 * a near-perfect score is a fair demand. SUMMARISING is not: a competent summary
 * groups and abstracts, and demanding it name 95% of individually-changed
 * symbols would push models toward identifier lists, which is the opposite of
 * what the command is for. 0.70 asks for substantial coverage while leaving room
 * to write like a person.
 */
export const DEFAULT_COMPARE_FILES_THRESHOLDS: CompareFilesThresholds = {
  minMicroF1: 0, // precision ungated — see the header
  minMicroRecall: 0.7,
  minCoverage: 0.9,
};

export function passesThresholds(
  score: CompareFilesScore,
  thresholds: CompareFilesThresholds = DEFAULT_COMPARE_FILES_THRESHOLDS,
): { pass: boolean; failures: string[] } {
  return sharedPassesThresholds(score, thresholds);
}
