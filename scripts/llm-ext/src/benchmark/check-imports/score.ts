/**
 * Deterministic scorer for the check_imports benchmark (TRDD-f45eeaa0).
 *
 * ── ZERO LLM JUDGE. Set math, end to end. ───────────────────────────────────
 *
 * WHAT IS SCORED: the SET of import specifiers a model extracts from a file's
 * text. check_imports is two-phase — the model extracts, the server then
 * resolves each against disk — so extraction is the only half a model can be
 * good or bad at, and a set is the natural unit of truth.
 *
 * ── THE MATH IS NOT COPIED — IT IS THE SAME MATH ────────────────────────────
 * `scoreCase` / `aggregateScores` / `passesThresholds` are IMPORTED from
 * search-existing/score.ts, exactly as scan-folder/score.ts imports them. Two
 * copies of a confusion matrix drift the day one is fixed.
 *
 * Reuse needs an argument, though, because the SHAPES differ: search_existing
 * and scan_folder score a per-FILE binary verdict, while this scores set
 * membership. They unify once you pick the right universe — for each file, the
 * union of (true specifiers ∪ reported specifiers), where "expected yes" is the
 * true set and the model's verdict on an item is "did you report it". Then
 * TP/FP/FN are literally the same counts:
 *   TP = correctly extracted, FP = invented, FN = missed.
 *
 * ── THE HONEST CONSEQUENCE OF THAT CHOICE ───────────────────────────────────
 * TRUE NEGATIVES ARE ALWAYS ZERO here, and that is correct rather than a
 * degenerate case: an item enters the universe only if it is true or was
 * reported, so "correctly did not report a specifier that was never there" has
 * no finite population to count over — every string that is not an import would
 * qualify. Precision, recall and F1 do not read trueNegatives, so the reported
 * figures are unaffected; only `trueNegatives` itself is uninformative, and it
 * is left visible rather than hidden so nobody reads meaning into a zero.
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

export type CheckImportsScore = SearchExistingScore;
export type CheckImportsThresholds = SearchExistingThresholds;
export type { CaseScore };

/**
 * Score ONE file: the model's extracted specifiers against the derived truth.
 *
 * `reported === null` means the report was missing or unparseable. That is NOT
 * silently a zero: every true specifier becomes a false negative (the model
 * asserted nothing about them), which is what an unusable answer deserves, and
 * the aggregate's coverage figure is what surfaces it as a systemic problem
 * rather than as poor accuracy.
 */
export function scoreFile(
  file: string,
  trueSpecifiers: readonly string[],
  reported: readonly string[] | null,
): CaseScore {
  const truth = new Set(trueSpecifiers);
  const got = new Set(reported ?? []);
  // The universe: everything that is true, plus everything claimed. See the
  // header for why this is the right population and why TN is therefore 0.
  const universe = [...new Set([...truth, ...got])];
  const verdicts = new Map<string, SectionVerdict>(
    universe.map((spec) => [
      spec,
      reported === null ? "unparseable" : got.has(spec) ? "yes" : "no",
    ]),
  );
  return scoreCase(file, universe, truth, verdicts);
}

export function scoreAll(cases: readonly CaseScore[]): CheckImportsScore {
  return aggregateScores(cases);
}

/**
 * Pass bar. RECALL IS THE WEIGHTED HALF, and more heavily than the sibling
 * benchmarks weight theirs, because the asymmetry is sharper here:
 *
 *   a MISSED specifier  -> phase 2 never resolves it, so a genuinely broken
 *                          import ships UNDETECTED. That is the exact failure
 *                          check_imports exists to prevent, so it defeats the
 *                          tool rather than degrading it.
 *   a SPURIOUS specifier -> phase 2 resolves it, finds it absent, and reports a
 *                          broken import that is not real. Noise, and a human
 *                          dismisses it in seconds.
 *
 * Extraction is also a MECHANICAL task, not a judgement call — the answer is
 * present in the text — so the bar is set above the 0.85 that search_existing
 * and scan_folder use for their genuinely semantic decisions. A model that
 * cannot read import statements out of source reliably has no business being
 * assigned this command.
 */
export const DEFAULT_CHECK_IMPORTS_THRESHOLDS: CheckImportsThresholds = {
  // PRECISION IS NOT GATED, and this is the load-bearing decision in this file.
  //
  // Read the tool's ACTUAL phase-1 prompt (index.ts, the check_imports case):
  //   "Extract ALL file path references and import statements … Include:
  //    import/require paths, file path strings, configuration references …
  //    Be exhaustive."
  //
  // It asks for strictly MORE than import specifiers. This dataset's oracle
  // derives ONLY import specifiers, because that is the part derivable from the
  // bytes with a bounded, nameable failure set — "is this string a configuration
  // reference?" is not decidable from source text, which is exactly the
  // unbounded-oracle trap that makes check_references the harder target.
  //
  // So a model obeying its instructions returns paths this oracle does not know
  // about, and gating on F1 would mark it WRONG FOR BEING RIGHT — precision about
  // the wrong question, which is the failure that survives review because a
  // deterministic scorer feels authoritative.
  //
  // The honest instrument is therefore RECALL-ONLY, the same shape the architect
  // prescribed for cluster_synonyms: we can prove the model MUST find these
  // specifiers (they are declared in the file); we cannot prove an extra path is
  // wrong. Precision and F1 are still COMPUTED and reported — a human reading a
  // run wants to see them — they simply do not gate.
  minMicroF1: 0,
  minMicroRecall: 0.95,
  minCoverage: 0.9,
};

/**
 * Pass = recall + coverage. See DEFAULT_CHECK_IMPORTS_THRESHOLDS for why
 * precision is reported but not gated.
 *
 * Recall is set high (0.95) because the asymmetry is sharp and one-directional:
 *   a MISSED specifier  -> phase 2 never resolves it, so a genuinely broken
 *                          import ships UNDETECTED. That defeats the command.
 *   an EXTRA path       -> phase 2 resolves it and either finds it or reports it
 *                          missing. At worst, noise a human dismisses.
 * Extraction is mechanical — the answer is present in the text — so a model that
 * cannot reach 0.95 recall on declared imports has no business being assigned it.
 */
export function passesThresholds(
  score: CheckImportsScore,
  thresholds: CheckImportsThresholds = DEFAULT_CHECK_IMPORTS_THRESHOLDS,
): { pass: boolean; failures: string[] } {
  return sharedPassesThresholds(score, thresholds);
}
