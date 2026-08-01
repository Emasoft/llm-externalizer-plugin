/**
 * Deterministic scorer for the code_task CODE-AUDIT benchmark (P2b).
 *
 * ── ZERO LLM JUDGE. The whole file is pure string + set math. ────────────────
 *
 * WHAT IS SCORED: **defect localization by SYMBOL NAME.**
 * The tool's own system prompt (scan-pipeline.ts::codeTaskSystemPrompt) orders
 * the model to "Identify code by FUNCTION/CLASS/METHOD NAME, never by line
 * number. Line numbers are unreliable." A line-based scorer would therefore be
 * grading models against an instruction the tool actively tells them to IGNORE.
 * The symbol name is the tool's own contract, so it is the only sound key. (The
 * dataset still records each defect's `line` — informational, for a human
 * reading the report; the scorer never reads it.)
 *
 * Expected set = the case's `buggySymbols` (empty for a clean fixture).
 * Returned set = the symbols the model actually accused, extracted from its
 * free-text report by `extractAccusedSymbols` below.
 * Score        = precision / recall / F1 per case (the same `scoreSet` math as
 *                benchmark/score.ts:63), micro-pooled + macro-averaged across
 *                cases (the same aggregate shape as search-existing/score.ts).
 *
 * ── WHAT IS **NOT** SCORED, and why (the honest ceiling) ────────────────────
 * The dataset carries a `defectClass` per case (e.g. "untrusted-YAML type
 * confusion"). It is REPORTED but never gated on. Deciding whether a model's
 * free-text explanation *means the same thing* as that label is a
 * semantic-equivalence judgment: an exact substring match is far too brittle
 * (models paraphrase), and anything looser needs an LLM judge — which this
 * benchmark excludes by design. Claiming to grade defect-class nuance
 * deterministically would be a lie, so we do not claim it. Localization is what
 * is honestly measurable, and it is the thing that actually matters: a reviewer
 * who is pointed at the right function reads the bug for themselves.
 *
 * ── HOW THE RETURNED SET IS EXTRACTED (two modes, both pure code) ───────────
 * ANCHORED (the happy path). `CODE_AUDIT_INSTRUCTIONS` asks the model to emit
 * `DEFECT: <symbol> — <why>` per finding, and `NO DEFECTS` when the file is
 * clean. That forced anchor is the same device search-existing uses (its per-file
 * YES/NO contract) and it makes extraction exact: when the report contains ≥1
 * anchored line, ONLY those lines are read. Prose elsewhere in the report cannot
 * manufacture a false positive.
 *
 * FREETEXT (the documented fallback). Some models ignore the format. Scoring
 * them 0 would measure instruction-following, not code understanding — a model
 * that writes "the bug is in `parseFileGroups`" FOUND the bug. So when there is
 * no anchored line, every universe symbol mentioned as a whole word on a line
 * that is not a NEGATION ("no issues", "looks correct", …) is taken as accused.
 * This is a heuristic, and it is honest about being one: the per-case score
 * records which mode ran, and the report prints it, so a run scored in freetext
 * mode is visibly weaker evidence than an anchored one. It is NOT a silent
 * error-swallowing fallback — nothing is hidden.
 *
 * A symbol the model names that is NOT in the fixture's AST universe is a
 * HALLUCINATION: it is counted and reported, but it cannot be a false positive
 * against a symbol that does not exist, so it does not enter the confusion
 * matrix (mirrors ModelScore.hallucinated in benchmark/score.ts:33).
 */

import type { CodeAuditCase } from "./dataset.js";

/** How the returned set was read out of the model's report. */
export type ParseMode = "anchored" | "freetext" | "empty";

/**
 * Lines that ASSERT THE ABSENCE of a problem. A universe symbol occurring on one
 * of these is NOT an accusation. Only consulted in freetext mode — the anchored
 * path cannot produce a false positive at all.
 *
 * Kept deliberately small and obvious: every pattern here is a phrase a reviewer
 * uses to CLEAR code. A wider net would start swallowing real findings.
 */
const NEGATION_PATTERNS: RegExp[] = [
  /\bno\s+(?:genuine\s+|real\s+|actual\s+)?(?:defect|bug|issue|problem|error|finding|concern)s?\b/i,
  /\bnot\s+(?:a\s+)?(?:defect|bug|issue|problem)\b/i,
  /\bno\s+changes?\s+(?:are\s+)?(?:needed|required)\b/i,
  /\b(?:looks?|seems?|appears?|is|are)\s+(?:to\s+be\s+)?(?:fine|correct|ok|okay|good|clean|sound|safe|valid)\b/i,
  /\b(?:correct|clean|fine|ok)\s*[.:—-]/i,
  /\bLGTM\b/i,
];

/**
 * The anchor `CODE_AUDIT_INSTRUCTIONS` asks for: `DEFECT: <symbol> — <why>`.
 * Tolerant of the decorations models add without changing the contract: a
 * leading list marker / heading, bold, and backticks around the symbol.
 * Examples all matched:
 *   DEFECT: parseFileGroups — order is lost
 *   - **DEFECT:** `parseFileGroups` - order is lost
 *   ## DEFECT: parseFileGroups
 */
const ANCHOR_RE =
  /^\s*(?:[-*+]\s*|#{1,6}\s*|\d+[.)]\s*)?\**\s*DEFECT\s*\**\s*:\s*\**\s*[`'"]?([A-Za-z_$][A-Za-z0-9_$]*)[`'"]?/i;

/** Whole-word, CASE-SENSITIVE occurrence of `name` in `line`. */
function mentionsSymbol(line: string, name: string): boolean {
  // Identifier boundaries, not \b: \b would match `parseFileGroups` inside
  // `_parseFileGroups`, and would NOT match `$foo`. Hand-rolled so a symbol
  // buried in a longer identifier is never a mention.
  const idx = indexOfIdentifier(line, name);
  return idx >= 0;
}

function indexOfIdentifier(haystack: string, name: string): number {
  const isIdent = (ch: string | undefined): boolean =>
    ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(name, from);
    if (i < 0) return -1;
    const before = i > 0 ? haystack[i - 1] : undefined;
    const after = i + name.length < haystack.length ? haystack[i + name.length] : undefined;
    if (!isIdent(before) && !isIdent(after)) return i;
    from = i + 1;
  }
}

function isNegated(line: string): boolean {
  return NEGATION_PATTERNS.some((re) => re.test(line));
}

/** What the extractor read out of one model report. */
export interface Accusation {
  /** Universe symbols the model accused (sorted, deduped). */
  accused: string[];
  /** Names the model accused that do NOT exist in the fixture. */
  hallucinated: string[];
  /** Which extractor produced `accused`. `empty` = the model accused nothing. */
  mode: ParseMode;
}

/**
 * Read the accused-symbol set out of ONE model report. Pure — no network, no
 * LLM. `universe` is the fixture's AST symbol list (dataset.ts's
 * listTopLevelSymbols): only names that really exist in the file can be scored.
 */
export function extractAccusedSymbols(
  report: string,
  universe: readonly string[],
): Accusation {
  const known = new Set(universe);
  const lines = report.split("\n");

  // ── Pass 1: ANCHORED. Exact, and immune to prose elsewhere in the report.
  const anchored = new Set<string>();
  const anchoredHallucinated = new Set<string>();
  let sawAnchor = false;
  for (const line of lines) {
    const m = ANCHOR_RE.exec(line);
    if (!m) continue;
    sawAnchor = true;
    const name = m[1];
    if (known.has(name)) anchored.add(name);
    else anchoredHallucinated.add(name);
  }
  if (sawAnchor) {
    return {
      accused: [...anchored].sort(),
      hallucinated: [...anchoredHallucinated].sort(),
      // An anchor that named ONLY non-existent symbols still parsed as anchored:
      // the model followed the contract, it just hallucinated the target. Scoring
      // that as `empty` would hide the hallucination.
      mode: "anchored",
    };
  }

  // ── Pass 2: FREETEXT. The model ignored the format. Accuse every universe
  // symbol named on a line that does not CLEAR it. Hallucinations are not
  // detectable here (an unknown identifier in prose is not an accusation — it is
  // just a word), so `hallucinated` is empty by construction in this mode.
  //
  // FENCED CODE IS SKIPPED. A model that quotes the file back at us — a fenced
  // block showing the offending lines, or worse the whole function — would
  // otherwise "accuse" every symbol that appears inside the quote, including the
  // innocent ones it merely echoed. That is not an accusation, it is a citation,
  // and counting it would hand a false positive to precisely the models that
  // explain themselves best.
  const accused = new Set<string>();
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (isNegated(line)) continue;
    for (const name of universe) {
      if (mentionsSymbol(line, name)) accused.add(name);
    }
  }
  return {
    accused: [...accused].sort(),
    hallucinated: [],
    mode: accused.size === 0 ? "empty" : "freetext",
  };
}

export interface CaseScore {
  caseId: string;
  file: string;
  /** The case's ground truth. */
  expected: string[];
  /** What the model accused. */
  returned: string[];
  truePositives: string[];
  falsePositives: string[];
  falseNegatives: string[];
  /** Named symbols that do not exist in the fixture (anchored mode only). */
  hallucinated: string[];
  /** Scorable top-level symbols in the fixture — the size of the choice. */
  universeSize: number;
  mode: ParseMode;
  precision: number;
  recall: number;
  f1: number;
  /** True iff the model named EXACTLY the buggy symbols — zero FP, zero FN. */
  exactMatch: boolean;
  /** The pipeline FAILED this case outright (no report to score). */
  failed: boolean;
  /** INFORMATIONAL — never gated on. See this file's header. */
  defectClass: string;
}

function safePrecision(tp: number, fp: number): number {
  // tp+fp === 0 means the model accused NOTHING. On a clean fixture that is the
  // correct answer, so precision is 1 — same convention as
  // search-existing/score.ts:50.
  return tp + fp === 0 ? 1 : tp / (tp + fp);
}

function safeRecall(tp: number, fn: number): number {
  // tp+fn === 0 means there was NOTHING to find (a clean fixture) — recall is
  // vacuously 1. Precision is what does the work on those cases.
  return tp + fn === 0 ? 1 : tp / (tp + fn);
}

function f1Of(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

/**
 * Score ONE case. `report` is the model's raw code_task output for the fixture;
 * `universe` is the fixture's AST symbol list. Pass `failed: true` when the
 * pipeline produced no usable report — the case is then scored with an EMPTY
 * accused set, so a degraded model loses recall on its defect cases rather than
 * being silently dropped from the denominator (search-existing/runner.ts:236
 * takes the same stance).
 */
export function scoreCase(
  c: CodeAuditCase,
  universe: readonly string[],
  report: string,
  failed = false,
): CaseScore {
  const { accused, hallucinated, mode } = failed
    ? { accused: [] as string[], hallucinated: [] as string[], mode: "empty" as ParseMode }
    : extractAccusedSymbols(report, universe);

  const expected = new Set(c.buggySymbols);
  const returned = new Set(accused);

  const truePositives: string[] = [];
  const falsePositives: string[] = [];
  const falseNegatives: string[] = [];
  for (const name of returned) {
    if (expected.has(name)) truePositives.push(name);
    else falsePositives.push(name);
  }
  for (const name of expected) {
    if (!returned.has(name)) falseNegatives.push(name);
  }

  const precision = safePrecision(truePositives.length, falsePositives.length);
  const recall = safeRecall(truePositives.length, falseNegatives.length);

  return {
    caseId: c.id,
    file: c.file,
    expected: [...expected].sort(),
    returned: [...returned].sort(),
    truePositives: truePositives.sort(),
    falsePositives: falsePositives.sort(),
    falseNegatives: falseNegatives.sort(),
    hallucinated: [...hallucinated].sort(),
    universeSize: universe.length,
    mode,
    precision,
    recall,
    f1: f1Of(precision, recall),
    exactMatch: falsePositives.length === 0 && falseNegatives.length === 0,
    failed,
    defectClass: c.defectClass,
  };
}

export interface CodeAuditScore {
  cases: CaseScore[];
  /** Micro-averaged over the POOLED confusion counts of every case. */
  microPrecision: number;
  microRecall: number;
  microF1: number;
  /** Unweighted mean of the per-case F1s — the RANKING key (see thresholds). */
  macroF1: number;
  /** Cases the model localized exactly (zero FP, zero FN). */
  exactMatches: number;
  /** Total invented symbol names across every case. */
  hallucinations: number;
  /** Cases whose report the pipeline never produced. */
  failedCases: number;
  /** Fraction of cases whose report parsed via the exact ANCHORED contract. */
  anchoredRate: number;
}

export function aggregateScores(cases: readonly CaseScore[]): CodeAuditScore {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let exact = 0;
  let hallucinations = 0;
  let failed = 0;
  let anchored = 0;
  for (const c of cases) {
    tp += c.truePositives.length;
    fp += c.falsePositives.length;
    fn += c.falseNegatives.length;
    if (c.exactMatch) exact++;
    hallucinations += c.hallucinated.length;
    if (c.failed) failed++;
    if (c.mode === "anchored") anchored++;
  }
  const microPrecision = safePrecision(tp, fp);
  const microRecall = safeRecall(tp, fn);
  return {
    cases: [...cases],
    microPrecision,
    microRecall,
    microF1: f1Of(microPrecision, microRecall),
    macroF1: cases.length === 0 ? 0 : cases.reduce((s, c) => s + c.f1, 0) / cases.length,
    exactMatches: exact,
    hallucinations,
    failedCases: failed,
    anchoredRate: cases.length === 0 ? 0 : anchored / cases.length,
  };
}

export interface CodeAuditThresholds {
  /** Mean per-case F1 — the primary bar. */
  minMacroF1: number;
  /** Pooled recall — a floor so a model cannot pass by staying silent. */
  minMicroRecall: number;
  /** Cases the pipeline may fail before the run is not evidence at all. */
  maxFailedCases: number;
}

/**
 * PASS GATE.
 *
 * `minMacroF1: 0.5` — taken verbatim from the P2 design spec, which anchors it
 * on security-triage's `minScore: 0.5` (security-triage/score.ts:97) rather than
 * on search-existing's 0.85. The distinction is the OUTPUT CONTRACT, not the
 * difficulty:
 *   • search-existing forces a per-file binary YES/NO, so its output is nearly
 *     noise-free and a 0.85 bar is fair.
 *   • code_task's output is a free-form code review. Even with the DEFECT:
 *     anchor, a real reviewer legitimately surfaces a second, unlisted concern
 *     in a 34 KB file, and that costs precision here by construction. Demanding
 *     0.85 would fail models that are perfectly good at the job, i.e. it would
 *     measure terseness rather than code understanding.
 * 0.5 is the same posture the other PROSE-output benchmark takes, and it is
 * still a real bar: a model must localize most defects AND stay quiet on the
 * clean fixtures to clear it (accusing one symbol per clean fixture zeroes that
 * case's F1 outright — precision 0).
 *
 * `minMicroRecall: 0.5` — a silence floor. macro-F1 alone can be gamed: a model
 * that says NO DEFECTS to everything scores F1 = 1 on all 3 clean cases and 0 on
 * the 5 defect cases → macro-F1 0.375, which already fails 0.5 — but with a
 * different corpus balance it might not. The explicit recall floor makes "find
 * nothing, ever" structurally unable to pass, no matter the mix. It mirrors
 * search-existing's own recall floor (score.ts:165) and its rationale: a MISSED
 * defect costs more than a spurious one.
 *
 * `maxFailedCases: 1` — one flaky pipeline failure (provider timeout) is
 * tolerated; two means the run is infrastructure noise, not evidence about the
 * model, and it must not be able to pass.
 */
export const DEFAULT_CODE_AUDIT_THRESHOLDS: CodeAuditThresholds = {
  minMacroF1: 0.5,
  minMicroRecall: 0.5,
  maxFailedCases: 1,
};

export function passesThresholds(
  score: CodeAuditScore,
  thresholds: CodeAuditThresholds = DEFAULT_CODE_AUDIT_THRESHOLDS,
): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  if (score.macroF1 < thresholds.minMacroF1) {
    failures.push(`macro-F1 ${score.macroF1.toFixed(3)} < ${thresholds.minMacroF1}`);
  }
  if (score.microRecall < thresholds.minMicroRecall) {
    failures.push(`micro-recall ${score.microRecall.toFixed(3)} < ${thresholds.minMicroRecall}`);
  }
  if (score.failedCases > thresholds.maxFailedCases) {
    failures.push(
      `${score.failedCases} case(s) produced no report (max ${thresholds.maxFailedCases}) — the run is infrastructure noise, not evidence`,
    );
  }
  return { pass: failures.length === 0, failures };
}
