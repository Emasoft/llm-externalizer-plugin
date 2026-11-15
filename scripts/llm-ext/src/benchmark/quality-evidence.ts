/**
 * ONE rule for when a benchmark run is evidence about the model at all, and what
 * the stored quality verdict is computed over (TRDD-90BXJ2KO).
 *
 * A case in which the model never produced an answer (transport or HTTP error,
 * rate limit, empty reply, no content) is UNSCORED, not wrong. The stored
 * `qualityPass` is computed over the ANSWERED cases only, and a run abstains (no
 * `qualityPass`, the row reads `untested`, re-tested in the background,
 * design/specs/profile-contract.md 4.3) when more than MAX_UNANSWERED_FRACTION of
 * its cases are unanswered. Storing `false` for such a run makes
 * profiles/verdicts.ts read `fail` and exclude a working model from routing.
 * code-task/score.ts already names an all-failed run "infrastructure noise, not
 * evidence"; this module makes every writer and the zero-call backfill act on it.
 *
 * A missing or non-numeric field is NOT provable non-evidence: the run is then
 * judged as before, never silently excused.
 */

/**
 * The most unanswered cases a run may have and still be scored. WHY: a run with
 * more than a quarter of its cases unanswered measures the provider availability,
 * not the model quality, and a wrong fail excludes a working model from routing
 * (TRDD-90BXJ2KO, 2026-11-15 free-pool sweep). 0.25 is exact in binary, so counts
 * compare exactly (2 of 8 is scored, 3 of 8 abstains).
 */
export const MAX_UNANSWERED_FRACTION = 0.25;

/** The shared rule: more than MAX_UNANSWERED_FRACTION of `total` cases got no answer. */
export function tooManyUnanswered(unanswered: number, total: number): boolean {
  return total > 0 && unanswered > total * MAX_UNANSWERED_FRACTION;
}

/** The failure line shown wherever a non-evidence run is judged for display or selection. */
export const NON_EVIDENCE_REASON = "over a quarter of the cases got no answer — not evidence about the model";

/**
 * check-specs, scan-folder, search-existing (all score as SearchExistingScore).
 * The unit is the scanned FILE (check-specs has one case of many files):
 * `unanswered` per case counts files with no verdict at all (request failed or
 * never ran, search-existing/score.ts scoreCase). A file whose reply could not be
 * parsed is an answer that broke the output contract, stays scored, and is not
 * counted here. A row written before the `unanswered` field cannot tell the two
 * apart, so it keeps the old strict rule: only coverage exactly 0 abstains.
 */
export function isUnansweredFilesNonEvidence(score: unknown): boolean {
  const s = score as { cases?: unknown; coverage?: unknown } | null | undefined;
  let unanswered = 0;
  let scanned = 0;
  let separable = Array.isArray(s?.cases);
  if (Array.isArray(s?.cases)) {
    for (const c of s.cases as { unanswered?: unknown; scannedFiles?: unknown }[]) {
      if (typeof c?.unanswered !== "number" || typeof c.scannedFiles !== "number") {
        separable = false;
        break;
      }
      unanswered += c.unanswered;
      scanned += c.scannedFiles;
    }
  }
  if (separable && scanned > 0) return tooManyUnanswered(unanswered, scanned);
  const coverage = s?.coverage;
  return typeof coverage === "number" && Number.isFinite(coverage) && coverage === 0;
}

/**
 * code-task (CodeAuditScore): `failedCases` counts cases the pipeline produced no
 * report for, out of `cases.length`. NOT macro-F1: a fully failed run still scores
 * the clean cases vacuous F1 = 1 (macro-F1 0.375 on the current corpus), so F1
 * cannot see the outage. An empty accused list WITHOUT the failed flag is a real
 * answer (a clean file) and counts as answered.
 */
export function isFailedCasesNonEvidence(score: unknown): boolean {
  const s = score as { cases?: unknown; failedCases?: unknown } | null | undefined;
  if (!Array.isArray(s?.cases) || typeof s.failedCases !== "number" || !Number.isFinite(s.failedCases)) return false;
  return tooManyUnanswered(s.failedCases, s.cases.length);
}

/**
 * text-tools (TextToolScore): `unansweredCases` counts cases in which the model
 * never returned any content. Echo / invalid-output rejections are wrong answers
 * and are not counted. A row without the field (written before it) cannot be
 * separated and is judged as before.
 */
export function isTextToolNonEvidence(score: unknown): boolean {
  const s = score as { totalCases?: unknown; unansweredCases?: unknown } | null | undefined;
  if (typeof s?.unansweredCases !== "number" || typeof s.totalCases !== "number") return false;
  return tooManyUnanswered(s.unansweredCases, s.totalCases);
}

/**
 * The verdict to store as `qualityPass`: `undefined` (abstain, the row reads
 * untested) for a non-evidence run, else the threshold verdict. `passes` must be
 * given the answered-only score (answeredOnlyScore / answeredOnlyTextToolScore),
 * or the failed-case and coverage gates would still fail a partly answered run.
 */
export function evidenceQualityPass<S>(
  score: S,
  isNonEvidence: (score: S) => boolean,
  passes: (score: S) => boolean,
): boolean | undefined {
  return isNonEvidence(score) ? undefined : passes(score);
}

/**
 * Write a verdict onto a ledger row. An abstention DELETES the field rather than
 * skipping the write: the writers run on same-day cache hits too, so the row may
 * already carry a `false` from before this rule, and leaving it would keep the
 * model wrongly excluded.
 */
export function recordQualityPass(row: { qualityPass?: boolean }, verdict: boolean | undefined, where: string): void {
  if (verdict === undefined) {
    // WHY logged: removing a stored verdict edits the ledger without a human decision,
    // so each removal leaves a trace naming the row and the reason (TRDD-90BXJ2KO).
    if (row.qualityPass !== undefined) {
      process.stderr.write(`[llm-ext] benchmark: removed qualityPass:${String(row.qualityPass)} from ${where}: non-evidence run (over a quarter of the cases got no answer)\n`);
    }
    delete row.qualityPass;
  } else row.qualityPass = verdict;
}
