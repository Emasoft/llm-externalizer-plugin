/**
 * Backfill `qualityPass` onto LEGACY ledger rows, using the score those rows
 * already carry — no model call, no cost.
 *
 * WHY THIS EXISTS
 * ---------------
 * `free-rotation.ts::parseBenchEvidence` ranks the free pool from a per-model
 * verdict, and for a ':free' model that verdict can ONLY come from
 * `qualityPass`: layer 2 falls back to `qualified`, which is `false` for the
 * entire ':free' class by design (allowFree:false), with a `disqualifyReason`
 * that `isNonQualityReason()` then skips. So a row without `qualityPass`
 * contributes nothing to ranking, whatever it scored.
 *
 * Each tool's runner already writes `qualityPass` on cache HITS as well as
 * misses, and its comment promises "legacy rows backfill on the next benchmark
 * run without a --force". That promise cannot be kept: the cache key is
 * `cacheKey(model.id, today(), datasetHash)`, so a row written on an EARLIER
 * DATE is never looked up again. A run today allocates a new key and pays for a
 * fresh live call; the old row stays inert forever.
 *
 * Measured on this machine 2026-08-29: 86 ledger rows across the five per-tool
 * files, 81 of them ':free', every one carrying a full `score` — and ZERO
 * carrying `qualityPass`. The evidence fold was therefore empty for exactly the
 * pool it exists to rank, which is what left a name-substring heuristic
 * (`looksLikeClassifier`) as the whole safety property (see TRDD-6HGJFPDR).
 *
 * This walks the ledger by VALUE rather than by today's key, so a row's own
 * persisted score decides its own verdict. Gated on `datasetHash`: a score is
 * only meaningful against the dataset it was produced from, so a row from an
 * older dataset is left alone rather than judged by today's threshold — except
 * that a `false` on a provably non-evidence run is removed under any hash (see
 * backfillLegacyQualityPass).
 */

/** The minimum row shape this needs; the real rows carry more. */
export interface BackfillableRow<S> {
  datasetHash?: string;
  score?: S;
  qualityPass?: boolean;
}

/**
 * Set `qualityPass` on every row that lacks it, was produced from
 * `datasetHash`, and carries a score. Returns how many rows were CHANGED
 * (upgraded or repaired) — the callers save the ledger only when it is > 0.
 *
 * `isNonEvidence` (quality-evidence.ts) marks a run in which more than a quarter
 * of the cases got no answer (TRDD-90BXJ2KO); `passes` is expected to judge the
 * answered-only score. Such a non-evidence row is never judged (it stays without
 * `qualityPass`, so it reads untested), and a row already carrying `false` for it
 * is REPAIRED by removing the field.
 *
 * Never overwrites an existing `qualityPass` — a verdict written at benchmark
 * time was computed with that run's own thresholds and stays authoritative —
 * with ONE narrow exception: `false` on a provably non-evidence run. That false
 * was never a verdict about the model (every request was refused, rate-limited
 * or returned nothing), and before the non-evidence rule both this backfill and
 * the live writers stored it, so the ledgers on disk carry it. It is removed
 * whatever the row's dataset hash: verdicts.ts and validated.ts read S2 rows
 * hash-agnostic, so an old-hash false still excludes the model. A `true` is
 * never touched.
 */
export function backfillLegacyQualityPass<S>(
  cache: Record<string, BackfillableRow<S>>,
  datasetHash: string,
  passes: (score: S) => boolean | undefined,
  // Typed on `unknown`, not S: a ledger row is untrusted JSON, and the rule must
  // not drive inference of S (it would widen S to unknown at every call site).
  isNonEvidence?: (score: unknown) => boolean,
  // Ledger file name, for the stderr line written on every repair (TRDD-90BXJ2KO).
  ledgerFile = "(unnamed ledger)",
): number {
  let changed = 0;
  for (const [key, row] of Object.entries(cache)) {
    if (!row || typeof row !== "object") continue;
    if (row.score === undefined || row.score === null) continue; // nothing to judge
    try {
      const nonEvidence = isNonEvidence?.(row.score) === true;
      if (row.qualityPass === false && nonEvidence) {
        delete row.qualityPass; // repair: a non-evidence false (see the doc above)
        // WHY logged: this edits the ledger on disk without a benchmark run, so every
        // removal must leave a trace naming the row and the reason.
        process.stderr.write(
          `[llm-ext] backfill: removed qualityPass:false from ${ledgerFile} row ${key}: non-evidence run (over a quarter of the cases got no answer, or none did; TRDD-90BXJ2KO)\n`,
        );
        changed++;
        continue;
      }
      if (row.qualityPass !== undefined) continue; // already judged — leave it
      if (row.datasetHash !== datasetHash) continue; // different dataset — not comparable
      if (nonEvidence) continue; // no usable answer — abstain, the row reads untested
      // `undefined` is the predicate ABSTAINING, not a failure: security-triage
      // marks a run `inconclusive`, and recording that as `false` would demote a
      // model the benchmark never actually judged.
      const verdict = passes(row.score);
      if (verdict === undefined) continue;
      row.qualityPass = verdict;
      changed++;
    } catch {
      // A malformed legacy score must not abort the run that was about to
      // benchmark real models. Leave the row unjudged and carry on.
    }
  }
  return changed;
}
