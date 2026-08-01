/**
 * Deterministic scorer for the scan_folder (MASS SEARCH) benchmark — P2c.
 *
 * ── ZERO LLM JUDGE. Pure string + set math, end to end. ─────────────────────
 *
 * WHAT IS SCORED: **the per-file verdict.** scan_folder makes one LLM call per
 * file and produces one report per file, so the thing the tool is actually good or
 * bad at is a per-file binary decision: does THIS file meet the stated criterion?
 * The dataset derives the true MATCH set mechanically from the corpus bytes
 * (dataset.ts::deriveMatchingFiles), the model states its verdict on an anchored
 * line, and the score is precision / recall / F1 over the two sets.
 *
 * ── THE MATH IS NOT COPIED — IT IS THE SAME MATH ────────────────────────────
 * `scoreCase` / `aggregateScores` are IMPORTED from search-existing/score.ts, not
 * re-implemented here. That is not laziness, it is the point: search_existing's
 * benchmark scores exactly this shape (a per-file binary verdict over a scanned
 * file set, micro-pooled and macro-averaged with a coverage ratio), and two copies
 * of a confusion matrix drift the day one is fixed. One definition, two importers —
 * the same call P2b made when it MOVED codeTaskSystemPrompt instead of copying it.
 *
 * The imported `SectionVerdict` spells its values "yes" / "no". Read them as
 * MATCH / NO_MATCH: the strings are the verdict's identity in the shared math, not
 * a claim about which tool's prompt produced them. `parseFileVerdict` below is the
 * scan_folder-specific half — the anchor contract this tool's instructions force.
 *
 * ── WHAT IS **NOT** SCORED, and why (the honest ceiling) ────────────────────
 * The instructions ask a MATCH line to cite "the exact identifier or import that
 * proves it", and the report prints those citations. They are NOT graded. Deciding
 * whether a cited identifier really PROVES the claim — as opposed to being a
 * plausible-looking name the model reached for — is a semantic-equivalence
 * judgment, and the only mechanical alternatives are both wrong: exact-substring
 * matching would fail a model that cites `spawnSync(...)` where truth says
 * `spawn`, and anything looser needs an LLM judge, which this benchmark excludes
 * by design. So the citation is required (it makes a lucky guess costlier than a
 * considered answer) and reported (a human can spot-check it), but the GATE is the
 * verdict, which is what is honestly measurable. Claiming otherwise would be a lie
 * dressed up as a metric.
 */

import type {
  SearchExistingScore,
  SearchExistingThresholds,
  SectionVerdict,
} from "../search-existing/score.js";

/**
 * TYPE aliases only — deliberately NOT a re-export of the shared `scoreCase` /
 * `aggregateScores` VALUES. Re-exporting those would create a second runtime path
 * to the same function (a shim), so scan_folder's runner and orchestrator import
 * them straight from `../search-existing/score.js`, where they are defined once.
 * Types are erased at build time, so aliasing them costs nothing and spares every
 * scan_folder module from spelling another tool's name in its own signatures.
 */
export type ScanFolderScore = SearchExistingScore;
export type ScanFolderThresholds = SearchExistingThresholds;

/**
 * NO_MATCH must be tested BEFORE MATCH: "NO_MATCH" contains "MATCH", and a
 * line-start MATCH test that ran first would still miss it (the `^` anchor sees
 * "NO"), but only by luck — a future tolerance tweak to the MATCH pattern could
 * quietly start reading every NO_MATCH as a MATCH. Testing the negative first
 * makes that class of bug impossible instead of merely unlikely.
 *
 * Both patterns tolerate the decorations models add without breaking the contract
 * (a list marker, a heading, bold), and both are anchored at line start so the
 * word appearing mid-sentence in prose can never be read as a verdict.
 */
const NO_MATCH_RE = /^\s*(?:[-*+]\s*|#{1,6}\s*|\d+[.)]\s*)?\**\s*NO[_\s-]?MATCH\b/i;
const MATCH_RE = /^\s*(?:[-*+]\s*|#{1,6}\s*|\d+[.)]\s*)?\**\s*MATCH\b/i;

/** The citation a MATCH line offered, for the report. Never graded. */
export interface ParsedVerdict {
  verdict: SectionVerdict;
  /** Text after `MATCH:` on the anchored line. Empty for NO_MATCH/unparseable. */
  evidence: string;
}

/**
 * Read ONE file's report into a verdict. Pure — no network, no LLM.
 *
 * The FIRST anchored line wins. The instructions say the first line of the reply
 * IS the verdict, so a model that later muses "…although it does call
 * writeFileSync" has not changed its answer, and letting a later line override the
 * stated one would be the scorer inventing an interpretation.
 *
 * Fenced code is skipped: a model that quotes the file (or the instructions) back
 * at us must not have its own quotation read as a verdict.
 *
 * No free-text fallback, deliberately. code_task's scorer has one because its
 * output is a free-form review where "the bug is in parseFileGroups" IS a finding.
 * Here the output is a forced binary; the only way to guess a verdict out of prose
 * that refused to state one is to interpret its meaning, which is a judge. An
 * unparseable report is therefore recorded as UNSCORED — it costs coverage, and it
 * costs recall when the file really was a match (search-existing/score.ts:91). It
 * is never silently dropped.
 */
export function parseFileVerdict(report: string): ParsedVerdict {
  let inFence = false;
  for (const raw of report.split("\n")) {
    if (/^\s*(?:`{3,}|~{3,})/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (NO_MATCH_RE.test(raw)) return { verdict: "no", evidence: "" };
    const m = MATCH_RE.exec(raw);
    if (m) {
      // Whatever follows the anchor is the model's cited evidence, with the
      // separator and any markdown around it stripped ("**MATCH:** `spawnSync`" →
      // "spawnSync"). An absent citation is still a MATCH — the VERDICT is the
      // graded thing (see this module's honest-ceiling note); the citation is only
      // printed for a human, so a cosmetic miss here cannot change a score.
      const evidence = raw
        .slice(m[0].length)
        .replace(/^[\s:*\-—`]+/, "")
        .replace(/[\s*`]+$/, "")
        .trim();
      return { verdict: "yes", evidence };
    }
  }
  return { verdict: "unparseable", evidence: "" };
}

/**
 * PASS GATE — the same numbers as search_existing_implementations
 * (DEFAULT_SEARCH_EXISTING_THRESHOLDS), and for the same reason, which is worth
 * stating because P2b's code-audit gate is deliberately HALF this:
 *
 *   • code_task emits a free-form code review. A good reviewer legitimately raises
 *     an unlisted second concern and LOSES PRECISION for it by construction, so its
 *     bar is 0.5 — a stricter one would measure terseness, not competence.
 *   • scan_folder (like search_existing) emits a FORCED BINARY per file. There is
 *     no such thing as a legitimate extra MATCH: the criterion is stated, the file
 *     either meets it or it does not, and the answer is derivable from the bytes.
 *     Noise is not structural here, so 0.85 is a fair bar and 0.5 would be a
 *     giveaway — a coin flip scores ~0.5 on a balanced binary.
 *
 * `minMicroRecall: 0.85` is a SILENCE FLOOR, not decoration. F1 alone is gameable
 * on any corpus with more negatives than positives: answer NO_MATCH to everything
 * and precision is vacuously 1 (nothing was asserted, so nothing was asserted
 * wrongly). The explicit recall floor makes "never find anything" structurally
 * unable to pass, whatever the corpus mix. There is a test that asserts exactly
 * this.
 *
 * `minCoverage: 0.9` is where a broken pipeline and a model that will not follow
 * the output contract both land: a file with no parseable verdict is UNSCORED, and
 * enough of them sink the run. It is what makes an API outage read as "no evidence"
 * rather than as a score.
 */
export const DEFAULT_SCAN_FOLDER_THRESHOLDS: ScanFolderThresholds = {
  minMicroF1: 0.85,
  minMicroRecall: 0.85,
  minCoverage: 0.9,
};

/**
 * Apply the gate. Not a pass-through of search-existing's `passesThresholds`: it
 * binds scan_folder's OWN default and phrases scan_folder's failure reasons, so a
 * later change to search_existing's bar cannot silently move this tool's.
 */
export function passesThresholds(
  score: ScanFolderScore,
  thresholds: ScanFolderThresholds = DEFAULT_SCAN_FOLDER_THRESHOLDS,
): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  if (score.microF1 < thresholds.minMicroF1) {
    failures.push(`micro-F1 ${score.microF1.toFixed(3)} < ${thresholds.minMicroF1}`);
  }
  if (score.microRecall < thresholds.minMicroRecall) {
    failures.push(
      `micro-recall ${score.microRecall.toFixed(3)} < ${thresholds.minMicroRecall} (a model that answers NO_MATCH to everything cannot pass)`,
    );
  }
  if (score.coverage < thresholds.minCoverage) {
    failures.push(
      `coverage ${score.coverage.toFixed(3)} < ${thresholds.minCoverage} — too many files produced no parseable verdict, so the run is not evidence about the model`,
    );
  }
  return { pass: failures.length === 0, failures };
}
