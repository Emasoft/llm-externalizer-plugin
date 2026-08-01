/**
 * Deterministic scorer for the check_against_specs (SPEC ADHERENCE) benchmark — P2d.
 *
 * ── ZERO LLM JUDGE. Pure string + set math, end to end. ─────────────────────
 *
 * WHAT IS SCORED: **the per-file verdict, and nothing else.** check_against_specs
 * in answer_mode 0 makes one LLM call per source file and emits one report per source
 * file, so the thing the tool is good or bad at is a per-file binary: does THIS file
 * violate the spec? The dataset carries the true label for every fixture (anchored in
 * the commit that really fixed the real violation), the model states its verdict on an
 * anchored line, and the score is precision / recall / F1 over the two sets.
 *
 * ── THE MATH IS NOT COPIED — IT IS THE SAME MATH ────────────────────────────
 * `scoreCase` / `aggregateScores` are IMPORTED from search-existing/score.ts, not
 * re-implemented here — exactly as scan-folder/score.ts does, and for the same reason:
 * this tool's output is the same per-file binary that benchmark already scores, and
 * two copies of a confusion matrix drift the day one of them is fixed. One definition,
 * three importers.
 *
 * The imported `SectionVerdict` spells its values "yes" / "no". Read them as
 * VIOLATION / CLEAN: those strings are the verdict's identity inside the shared math,
 * not a claim about which tool's prompt produced them.
 *
 * ── WHAT IS **NOT** SCORED, and why (the honest ceiling) ────────────────────
 * The P2 dataset spec judged this tool only PARTIALLY deterministic, and it was right.
 * Two things the tool emits are deliberately left ungraded, because grading them needs
 * an LLM judge and a judge is excluded by design:
 *
 *   1. EXACT-RULE MATCH. A VIOLATION line names the rule it thinks was broken, and the
 *      report prints it. It is NOT graded. Deciding whether that text really refers to
 *      the intended clause — rather than a coincidental unrelated nitpick — is a
 *      semantic-equivalence judgment. Exact substring matching would fail a model that
 *      paraphrases correctly; anything looser IS a judge. The corpus mitigates this
 *      structurally instead: every VIOLATION fixture has exactly ONE plausible thing
 *      wrong with it, so "flagged a violation" and "flagged THE violation" coincide
 *      with high probability. That is a mitigation, not a proof, and it is stated as
 *      such rather than smuggled past as a metric.
 *   2. SEVERITY. CRITICAL / HIGH / MEDIUM / LOW is a judgment human reviewers disagree
 *      about. A `Severity: X` regex is trivial; scoring it correct/incorrect requires a
 *      rubric somebody's opinion authored. Not a gate, not a metric, not here.
 *
 * A benchmark that claimed to validate violation-CONTENT quality would be lying. This
 * one gates on the one thing that is honestly measurable: did the model flag the files
 * that really are broken, and leave the ones that are not alone?
 */

import type {
  SearchExistingScore,
  SearchExistingThresholds,
  SectionVerdict,
} from "../search-existing/score.js";

/**
 * TYPE aliases only — deliberately NOT a re-export of the shared `scoreCase` /
 * `aggregateScores` VALUES. Re-exporting those would create a second runtime path to
 * the same function (a shim); the runner and orchestrator import them straight from
 * `../search-existing/score.js`, where they are defined once. Types are erased at build
 * time, so aliasing them costs nothing.
 */
export type CheckSpecsScore = SearchExistingScore;
export type CheckSpecsThresholds = SearchExistingThresholds;

/**
 * The anchors. Both are line-start anchored, so neither word can be read as a verdict
 * when it appears mid-sentence in prose, and both tolerate the decorations models add
 * without breaking the contract (a list marker, a heading, bold).
 *
 * ORDER IS SAFE, AND CHECKED. Unlike scan_folder's MATCH/NO_MATCH pair (where one
 * string literally contains the other), "VIOLATION" and "CLEAN" are disjoint at line
 * start: a line beginning "CLEAN — no spec violations found." cannot match a
 * line-start /VIOLATION/, and a line beginning "VIOLATION: …" cannot match a
 * line-start /CLEAN/ even when its prose later says "not clean". There is a test for
 * both of those exact strings, because "it happens to be fine" is how a future
 * tolerance tweak quietly introduces the bug.
 *
 * The CLEAN anchor deliberately does NOT require the full sentence "CLEAN — no spec
 * violations found." A model that opens with "CLEAN." has stated the verdict the
 * contract asks for; failing it for punctuation would be scoring formatting.
 */
const VIOLATION_RE = /^\s*(?:[-*+]\s*|#{1,6}\s*|\d+[.)]\s*)?\**\s*VIOLATION\b/i;
const CLEAN_RE = /^\s*(?:[-*+]\s*|#{1,6}\s*|\d+[.)]\s*)?\**\s*CLEAN\b/i;

/** The rule a VIOLATION line named, for the report. Never graded (see the header). */
export interface ParsedSpecVerdict {
  verdict: SectionVerdict;
  /** Text after `VIOLATION:` on the anchored line. Empty for CLEAN/unparseable. */
  citedRule: string;
}

/**
 * Read ONE file's spec-audit report into a verdict. Pure — no network, no LLM.
 *
 * The FIRST anchored line wins. The instructions say the first line of the reply IS
 * the verdict, so a model that later muses "…although one could argue the helper is
 * borderline" has not changed its answer, and letting a later line override the stated
 * one would be the scorer inventing an interpretation.
 *
 * Scanning ALL lines for the first anchored one (rather than looking only at line 1)
 * is deliberate: models routinely open with a preamble, and the tool's own system
 * prompt independently mandates the "CLEAN — no spec violations found." sentence
 * (check-specs/core.ts:157) without saying where to put it. A verdict stated on line 3
 * is still a stated verdict.
 *
 * Fenced code is skipped: a model that quotes the file — or the instructions — back at
 * us must not have its own quotation read as a verdict. The audited files are TEST
 * files full of assertions about strings; quoting one is exactly what a thorough
 * auditor does.
 *
 * NO FREE-TEXT FALLBACK, deliberately. code_task's scorer has one because its output is
 * a free-form review where "the bug is in parseFileGroups" IS a finding. Here the
 * output is a forced binary; the only way to guess a verdict out of prose that refused
 * to state one is to interpret its meaning — which is a judge, and this benchmark does
 * not have one. An unparseable report is recorded as UNSCORED: it costs coverage, and
 * it costs recall when the file really was a violation. It is never silently dropped.
 */
export function parseSpecVerdict(report: string): ParsedSpecVerdict {
  let inFence = false;
  for (const raw of report.split("\n")) {
    if (/^\s*(?:`{3,}|~{3,})/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const v = VIOLATION_RE.exec(raw);
    if (v) {
      // Whatever follows the anchor is the rule the model says was broken, with the
      // separator and any markdown stripped ("**VIOLATION:** `R2`" → "R2"). An absent
      // citation is still a VIOLATION — the VERDICT is the graded thing; the citation
      // is only printed for a human, so a cosmetic miss here cannot change a score.
      const citedRule = raw
        .slice(v[0].length)
        .replace(/^[\s:*\-—`]+/, "")
        .replace(/[\s*`]+$/, "")
        .trim();
      return { verdict: "yes", citedRule };
    }
    if (CLEAN_RE.test(raw)) return { verdict: "no", citedRule: "" };
  }
  return { verdict: "unparseable", citedRule: "" };
}

/**
 * Accuracy — REPORTED, never gated.
 *
 * It is here because it is the metric everyone asks for, and it is not the gate because
 * on an imbalanced corpus it flatters the useless: this corpus is 4 VIOLATION / 9 CLEAN,
 * so a model that answers CLEAN to every single file scores 0.69 accuracy while having
 * found nothing at all. F1 and the recall floor are what make that impossible. Printing
 * accuracy next to them (rather than instead of them) is the honest arrangement.
 *
 * Unscored files count against it, exactly as they count against coverage: a file with
 * no parseable verdict was not answered correctly.
 */
export function accuracyOf(score: CheckSpecsScore): number {
  let correct = 0;
  let total = 0;
  for (const c of score.cases) {
    correct += c.truePositives + c.trueNegatives;
    total += c.scannedFiles;
  }
  return total === 0 ? 0 : correct / total;
}

/**
 * PASS GATE — and every number in it is a decision, not an inheritance.
 *
 * `minMicroF1: 0.80`, one notch below scan_folder's and search_existing's 0.85.
 *   Those two tools force a one-line answer to a question with a mechanically derivable
 *   answer. This one asks for a free-form compliance report against a prose spec, where
 *   an auditor can legitimately be a little more or a little less cautious at the
 *   margin — `test-helpers.test.ts` is a real file about which a careful reader could
 *   over-worry. 0.80 prices in ONE such over-flag at full recall (4 TP, 2 FP → F1 0.80)
 *   without pricing in a model that cannot read the code (see the baselines below). It
 *   is emphatically NOT code_task's 0.50: that bar exists because a free-form code
 *   review loses precision BY CONSTRUCTION when a good reviewer raises an unlisted
 *   concern. Here the question is closed — this file either breaks the spec or it does
 *   not — so 0.50 would be a giveaway (a coin flip scores ~0.5 on a binary).
 *
 * `minMicroRecall: 0.70` is a SILENCE FLOOR, and it is load-bearing.
 *   "Answer CLEAN to everything" asserts nothing, so it is never WRONG: precision is
 *   vacuously 1.0 and F1 alone cannot punish it on a corpus with more negatives than
 *   positives. The explicit floor makes perpetual silence STRUCTURALLY unable to pass.
 *   0.70 with four violations means: catch at least THREE of the four. Catching three
 *   with a clean sheet passes (F1 0.857); catching three while also over-flagging one
 *   does not (F1 0.75); catching two cannot pass at all (recall 0.50). That calibration
 *   is pinned in a test, because a corpus edit that changed the violation count would
 *   silently change how many misses are tolerated.
 *
 * `minCoverage: 0.90` is where a broken pipeline and a model that will not follow the
 *   output contract both land: a file with no parseable verdict is UNSCORED, and enough
 *   of them sink the run. It is what makes an API outage read as "no evidence about this
 *   model" rather than as a score.
 */
export const DEFAULT_CHECK_SPECS_THRESHOLDS: CheckSpecsThresholds = {
  minMicroF1: 0.8,
  minMicroRecall: 0.7,
  minCoverage: 0.9,
};

/**
 * Apply the gate. Not a pass-through of search-existing's `passesThresholds`: it binds
 * check_against_specs's OWN defaults and phrases its own failure reasons, so a later
 * change to another tool's bar cannot silently move this one's.
 */
export function passesThresholds(
  score: CheckSpecsScore,
  thresholds: CheckSpecsThresholds = DEFAULT_CHECK_SPECS_THRESHOLDS,
): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  if (score.microF1 < thresholds.minMicroF1) {
    failures.push(`micro-F1 ${score.microF1.toFixed(3)} < ${thresholds.minMicroF1}`);
  }
  if (score.microRecall < thresholds.minMicroRecall) {
    failures.push(
      `micro-recall ${score.microRecall.toFixed(3)} < ${thresholds.minMicroRecall} (a model that answers CLEAN to everything cannot pass)`,
    );
  }
  if (score.coverage < thresholds.minCoverage) {
    failures.push(
      `coverage ${score.coverage.toFixed(3)} < ${thresholds.minCoverage} — too many files produced no parseable verdict, so the run is not evidence about the model`,
    );
  }
  return { pass: failures.length === 0, failures };
}

// ── The discrimination check ────────────────────────────────────────────────

/**
 * A cheap strategy that does not read code. Given a fixture's raw bytes, it returns a
 * verdict — the same "yes"/"no" the real scorer produces — so it can be pushed through
 * the REAL scorer and the REAL gate.
 */
export interface NaiveStrategy {
  id: string;
  /** What it does, and why someone might think it is good enough. */
  description: string;
  decide: (fileContent: string) => SectionVerdict;
}

/**
 * THE MANDATORY ADVERSARIES.
 *
 * P2c shipped a first corpus that a pure keyword matcher scored F1 0.909 on. It passed
 * the gate. It measured NOTHING — the "benchmark" would have handed a passing grade to
 * `grep`. The corpus was rebuilt and the lesson made structural: a benchmark is only
 * worth its cost if a strategy that never reads the code FAILS it, and that has to be
 * ASSERTED, not assumed.
 *
 * So these four run against the real corpus in bench-runner.test.ts, through the real
 * scorer and the real gate, and every one of them MUST fail. If a corpus edit ever lets
 * one through, the corpus is worthless and the test says so before anyone spends a cent
 * on it.
 *
 * They are ordered by how much they know: the last one has been TOLD the spec's rule and
 * still cannot apply it, which is the point of the whole corpus design.
 */
export const NAIVE_STRATEGIES: NaiveStrategy[] = [
  {
    id: "flag-everything",
    description:
      "Answer VIOLATION to every file. Costs nothing, catches every real violation — " +
      "perfect recall. It fails on precision, which is exactly what precision is for.",
    decide: () => "yes",
  },
  {
    id: "flag-nothing",
    description:
      "Answer CLEAN to every file. Never wrong about a clean file, so precision is " +
      "vacuously perfect and F1 alone would not punish it hard enough on a corpus with " +
      "more clean files than violations. The RECALL FLOOR is what kills it — that is " +
      "the floor's entire job.",
    decide: () => "no",
  },
  {
    id: "spec-vocabulary-grep",
    description:
      "Flag any file that talks about the things the spec talks about — OPENROUTER_API_KEY, " +
      "LIVE_TESTS, settings.yaml, openrouter. This is the strategy that would have passed " +
      "P2c's first corpus. Here it is worse than useless: the FIXED twins discuss the " +
      "subject MORE than the broken ones did (the fix added the explanatory comments), and " +
      "config.test.ts carries the OpenRouter URL as a string constant. The vocabulary is " +
      "anti-correlated with the truth.",
    decide: (c) => (/OPENROUTER_API_KEY|LIVE_TESTS|settings\.yaml|openrouter/i.test(c) ? "yes" : "no"),
  },
  {
    id: "missing-live-gate-grep",
    description:
      "The strongest cheap adversary: a grep that has been HANDED spec rule R2 — 'flag any " +
      "file with no LIVE_TESTS gate'. It catches all four real violations. It also flags " +
      "every ordinary offline unit test in the corpus, because a test that makes no LLM " +
      "call needs no gate — a fact that is in the code and not in the vocabulary. Knowing " +
      "the rule is not the same as being able to apply it.",
    decide: (c) => (/LIVE_TESTS/.test(c) ? "no" : "yes"),
  },
];
