/**
 * Golden dataset for the compare_files benchmark (TRDD-2G6D42LK).
 *
 * ── WHAT IS SCORED, AND WHY IT IS NOT "SUMMARY QUALITY" ─────────────────────
 * compare_files "auto-computes unified diff, LLM summarises differences"
 * (tools/definitions.ts). The DIFF is deterministic; only the summary is the
 * model's. Judging whether a summary is *good* needs a judge, which is why this
 * command sat at `benchmark: null` for months.
 *
 * A bounded sub-question does not need one: **did the summary MENTION the
 * symbols the diff actually changed?** The changed-symbol set is derivable from
 * the diff bytes, so recall over it is deterministic and honest.
 *
 * RECALL-ONLY, for the same reason check-imports is: we can prove a symbol
 * changed, so failing to mention it is a real miss. We CANNOT prove that a
 * symbol the summary did not mention was unimportant, nor that prose naming
 * something else is wrong — a good summary legitimately generalises ("renamed
 * the three backfill helpers"). Gating on precision would punish that.
 *
 * A hallucination signal is still computed and REPORTED — symbols named that
 * appear nowhere in the diff — because a human reading a run wants it. It does
 * not gate, for the reason above.
 *
 * ── THE CORPUS IS THIS REPO'S OWN COMMITS ───────────────────────────────────
 * benchmark-fixtures/compare-files/diffs/ holds FIVE real `git show` outputs
 * from this repository, captured verbatim. Real changes that really shipped —
 * the same principle as code_task's pre-fix snapshots and check-imports' copied
 * sources. Nothing is authored to fit the test.
 *
 * ── THE ONE EXCLUSION, MEASURED RATHER THAN ASSUMED ─────────────────────────
 * The fixtures are SOURCE-ONLY (`scripts/llm-ext/src/*.ts`, `dist` excluded).
 * Probing commit e2aecfa across everything returned `resolve12` and `factory2`
 * — bundler-generated names from the committed bundle, not source symbols. A
 * truth set polluted with those would demand a summary mention noise no human
 * would ever write. This is a FINITE, NAMEABLE failure mode, which is the
 * criterion that decides whether a derivation is safe to build on at all.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DiffCase {
  /** Fixture basename without extension — the short commit sha. */
  id: string;
  /** Symbols the diff adds, removes or modifies. The gradeable truth. */
  changedSymbols: string[];
}

export const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../benchmark-fixtures/compare-files/diffs",
);

/**
 * A top-level declaration whose NAME a summary should be able to state. Narrow
 * on purpose: an over-large truth set punishes good answers under RECALL
 * scoring, so under-representing some real changes is the correct direction.
 */
const TOP_LEVEL_DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|interface|type|class|enum)\s+([A-Za-z_$][\w$]*)/;

/**
 * Derive the changed-symbol set from a unified diff.
 *
 * TOP-LEVEL ONLY, and that is load-bearing rather than tidy. The first version
 * of this matched a declaration ANYWHERE on a touched line, and measuring it
 * against the corpus returned locals — `c`, `empty`, `cases`, `verdict` — from
 * inside test bodies. No useful summary names a local called `c`, so those
 * entries would have made a good answer look incomplete. Requiring column 0
 * (no leading whitespace after the +/- marker) is what restricts this to the
 * exported API a summary would actually discuss.
 *
 * Only `+`/`-` lines count, and `+++`/`---` file headers are skipped — they
 * start with the same characters and would otherwise contribute path fragments
 * as if they were symbols.
 */
export function deriveChangedSymbols(diff: string): string[] {
  const found: string[] = [];
  for (const line of diff.split("\n")) {
    if (!/^[+-]/.test(line)) continue;
    if (/^(\+\+\+|---)/.test(line)) continue;
    const m = TOP_LEVEL_DECLARATION.exec(line.slice(1));
    if (m?.[1] && !found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

export function loadDataset(): DiffCase[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".diff"))
    .sort()
    .map((f) => ({
      id: f.replace(/\.diff$/, ""),
      changedSymbols: deriveChangedSymbols(readFileSync(join(FIXTURE_DIR, f), "utf-8")),
    }));
}

/**
 * TRIPWIRE, not the definition — recomputed and compared by validateDataset,
 * which THROWS on disagreement so a fixture edit cannot quietly move the answer.
 *
 * Counts, not lists: a count is what a human can check against the diff by eye.
 *
 * HONEST PROVENANCE, because the check-imports tripwire earned this note by
 * catching two of my own miscounts: these five numbers WERE taken from the
 * derivation, so as a count-vs-count check they are a mirror, not an
 * independent measurement. What IS independent is the check that mattered —
 * the derived NAMES were read and confirmed to be exported API a summary would
 * plausibly discuss (`scoreFile`, `buildCheckImportsExtractMessages`,
 * `backfillOwnLedger`), which is what exposed the two oracle defects: an
 * earlier rule returned locals (`c`, `empty`) from inside function bodies, and
 * three fixtures derived ZERO symbols and were replaced. Treat the counts as a
 * CHANGE DETECTOR (a fixture edit must not silently move an answer), not as
 * corroboration of the rule.
 */
export const EXPECTED_SYMBOL_COUNTS: Readonly<Record<string, number>> = Object.freeze({
  "41be1e5": 7,
  "8a6ac22": 16,
  a67c9ec: 10,
  fb6d782: 4,
  fdbcd87: 11,
});

export function validateDataset(cases: DiffCase[] = loadDataset()): void {
  const derived = Object.fromEntries(cases.map((c) => [c.id, c.changedSymbols.length]));
  const want = Object.keys(EXPECTED_SYMBOL_COUNTS).sort();
  const got = Object.keys(derived).sort();
  if (want.join(",") !== got.join(",")) {
    throw new Error(
      `compare-files dataset: corpus changed. expected [${want.join(", ")}], found [${got.join(", ")}]`,
    );
  }
  const mismatches: string[] = [];
  for (const [id, n] of Object.entries(EXPECTED_SYMBOL_COUNTS)) {
    if (derived[id] !== n) mismatches.push(`${id}: derived ${derived[id]}, tripwire says ${n}`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `compare-files dataset: ${mismatches.length} tripwire mismatch(es) — ${mismatches.join("; ")}. ` +
        "Reconcile DELIBERATELY by reading the diff; do not adopt the derived number.",
    );
  }
}
