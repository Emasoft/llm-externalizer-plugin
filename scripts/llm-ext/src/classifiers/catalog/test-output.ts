// SP-17 (TRDD-O5NUD6IT), plan §9 `classify test-output` (Moreno review_test_output idea): grep finds the failing blocks of a test log, Jev says regression vs flaky vs environment. Question text is our own wording (D17). The source repository was not on disk when this was written, so the rules come from the plan row and the card only.
import { z } from "zod";
import { choice, noul, score } from "../l1/questions.js";
import { SCORE_POLICY, type NoulAnswer } from "../l1/validate.js";
import type { ChoiceAnswer } from "../l1/validate-choice.js";
import type { ScoreAnswer } from "../l1/validate-score.js";
import { indexKey } from "../l2/ids.js";
import { dataGuard, isBlank, renumberByPosition } from "./shared.js";
import type { Answers, BuiltUnit, DecisionSpec, ProjectCtx, Thresholds } from "./spec.js";

// Why a fixed pattern and a line cap: this is the only regex run in this process, so it must stay linear (literal alternatives, no nesting) and never see more than LINE_CAP characters of a line. A caller's own pattern is never run here (plan §9 `classify extract`: "regex worker"; SP-22 runs user regexes in a worker thread with a timeout); the caller passes the matching line numbers as `matches`.
// shortcut: a fixed word list, extend it when a runner prints failures in other words.
const DEFAULT_PATTERN = /\b(?:FAIL(?:ED|URE)?|ERROR|FATAL|exception|traceback|assertion ?error|panic|segmentation fault|timed? ?out|not ok)\b|[✗✘]/i;
const LINE_CAP = 4000;

// Why exported: the regex worker line mode (l2/regex-worker.ts, Z55FYUQH) must number lines exactly as this schema counts them, and its test compares against this function itself, not a copy.
export const splitLines = (log: string): string[] => {
  const lines = log.split(/\r?\n/);
  // Why drop the last empty piece: "a\nb\n" has two lines, not three.
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

const testOutputInput = z
  .strictObject({
    log: z.string().refine((s) => !isBlank(s), "log must not be blank"),
    // 1-based numbers of the lines that show a failure, found by the caller with its own pattern in the isolated regex worker (SP-22). Absent: the built-in pattern decides. Empty: nothing matched.
    matches: z.array(z.number().int().min(1)).optional(),
    // Lines kept on each side of a failing line.
    context: z.number().int().min(0).max(100).default(5),
  })
  .superRefine((v, ctx) => {
    if (v.matches === undefined) return;
    if (v.matches.some((n, k) => k > 0 && n <= v.matches![k - 1]!)) ctx.addIssue({ code: "custom", message: "matches must be strictly ascending line numbers" });
    const count = splitLines(v.log).length;
    if (v.matches.some((n) => n > count)) ctx.addIssue({ code: "custom", message: `matches names a line beyond the log's ${count} lines` });
  });
export type TestOutputInput = z.output<typeof testOutputInput>;

export type FailureClass = "regression" | "flaky" | "environment" | "no_failure";
// Why the last label is the catch-all: a chunk whose top label is the default does not vote in the chunk merge (E117), so a quiet chunk cannot hide the one that shows the failure.
const DEFAULT_CLASS: FailureClass = "no_failure";
// Same four levels as the reference (Moreno jev_mcp.py:243: Informational, Minor, Major, Blocking), our own wording.
const SEVERITY = ["informational", "minor", "major", "blocking"] as const;
const NAMES = ["class", "regression", "severity", "evidence"] as const;

type Part = "failing" | "rest";
interface Range { from: number; to: number }
interface Layout { lines: string[]; failing: Range[]; rest: Range[]; parts: Part[] }

// 1-based, inclusive line ranges. Failing windows come first (E74), then the lines left over, so the whole log is read and nothing is cut.
// Why memoised per input object: chunkDefaults, build and project all need it, and the grep over a large log should run once per call.
const layouts = new WeakMap<TestOutputInput, Layout>();
function layoutOf(i: TestOutputInput): Layout {
  const known = layouts.get(i);
  if (known !== undefined) return known;
  const made = computeLayout(i);
  layouts.set(i, made);
  return made;
}

function computeLayout(i: TestOutputInput): Layout {
  const lines = splitLines(i.log);
  const hit = i.matches === undefined ? undefined : new Set(i.matches);
  const failing: Range[] = [];
  lines.forEach((l, k) => {
    if (!(hit === undefined ? DEFAULT_PATTERN.test(l.slice(0, LINE_CAP)) : hit.has(k + 1))) return;
    const from = Math.max(1, k + 1 - i.context);
    const to = Math.min(lines.length, k + 1 + i.context);
    const last = failing.at(-1);
    // Why merge touching windows: two windows with no line between them are one block.
    if (last !== undefined && from <= last.to + 1) last.to = Math.max(last.to, to);
    else failing.push({ from, to });
  });
  const rest: Range[] = [];
  let next = 1;
  for (const f of failing) {
    if (f.from > next) rest.push({ from: next, to: f.from - 1 });
    next = f.to + 1;
  }
  if (next <= lines.length) rest.push({ from: next, to: lines.length });
  return { lines, failing, rest, parts: [...(failing.length > 0 ? ["failing" as const] : []), ...(rest.length > 0 ? ["rest" as const] : [])] };
}

// The text of a unit: its blocks, each under a header with its original line range, so a reader of the chunk can find the lines in the log.
const textOf = (l: Layout, part: Part): string =>
  (part === "failing" ? l.failing : l.rest).map((r) => `--- log lines ${r.from}-${r.to} ---\n${l.lines.slice(r.from - 1, r.to).join("\n")}`).join("\n");

export interface UnitRow {
  /** failing: the grep-found blocks; rest: every other line of the log. */
  part: Part;
  failure_class: FailureClass | null;
  regression: number | null;
  severity: { score: number; level: (typeof SEVERITY)[number] } | null;
  evidence_sufficient: number | null;
  /** Why this part has no usable answer (invalid_response, not_sent_fatal, not_sent_budget, aborted, or the validation reason); null otherwise. */
  invalid: string | null;
  /** True when the runner reports that the four answers of this part were decided by different chunks (the fan-out merges per question). */
  mixed_chunks: boolean;
}
export interface TestOutputResult {
  /** Line ranges of the grep-found failing blocks, in log order. */
  failing_blocks: { from: number; to: number }[];
  /** The part with the highest regression probability (ties: the failing blocks, which come first); all null when no part was answered. */
  failure_class: FailureClass | null;
  regression: number | null;
  severity: UnitRow["severity"];
  evidence_sufficient: number | null;
  /** The deciding part's mixed_chunks: class, severity and evidence may then describe other chunks than the regression probability. */
  mixed_chunks: boolean;
  likely_regression: boolean;
  /** Evidence below the threshold for a shown failure, or a part of the log that was not answered. */
  insufficient: boolean;
  parts: UnitRow[];
  invalid: { part: Part; reason: string }[];
}

export const spec: DecisionSpec<TestOutputInput, TestOutputResult> = {
  id: "test-output",
  input: testOutputInput,
  thresholds: {
    regression: { default: 0.5, min: 0, max: 1, help: "--regression: lowest p that the failure is a code regression; at or above it the run needs attention" },
    evidence: { default: 0.5, min: 0, max: 1, help: "--evidence: lowest p that the log shows enough to tell the cause; below it a shown failure needs attention" },
  },
  split: "per-item",
  injection: "index-scoped",
  // Why SCORE_POLICY: the policy has one probabilities setting for all questions and the severity score may omit its list (plan §6); the class only labels the failure, the decision rests on the regression and evidence nouls.
  validation: SCORE_POLICY,
  // E117: every part is a text unit with a class question; chunks that say "no_failure" do not vote.
  chunkDefaults: (i) => Object.fromEntries(layoutOf(i).parts.map((_, j) => [indexKey("class", j), DEFAULT_CLASS])),
  build(i) {
    const l = layoutOf(i);
    const units: BuiltUnit[] = l.parts.map((part, j) => {
      const at = `units[${j}]`;
      const guard = dataGuard(`the test output in \`${at}\``, "analyse");
      return {
        kind: "text",
        // Why a bare string: the planner chunks a string state by lines; an object state would be split by entries.
        state: textOf(l, part),
        questions: {
          [indexKey("class", j)]: choice(`What most likely caused the failure shown in \`${at}\`? If it shows no failing test or error, answer no_failure. ${guard}`, {
            regression: "The code under test changed behaviour or has a defect",
            flaky: "The failure is intermittent: timing, ordering, randomness or shared state",
            environment: "The machine, network, dependencies, configuration or tooling failed, not the code under test",
            no_failure: "No failing test or error is shown",
          }),
          [indexKey("regression", j)]: noul(`Does \`${at}\` give evidence of a regression in the code under test rather than only an environment or tooling problem? ${guard}`),
          [indexKey("severity", j)]: score(`Rate the impact of the failure shown in \`${at}\` on the development or runtime workflow it affects. ${guard}`, [
            "Informational: no effect on the workflow, a notice only.",
            "Minor: a small or non-essential part is affected, work continues.",
            "Major: an important feature or many tests are affected.",
            "Blocking: the build or a core feature is broken, work cannot continue.",
          ]),
          [indexKey("evidence", j)]: noul(`Does \`${at}\` show enough to identify the kind of failure with useful confidence? ${guard}`),
        },
      };
    });
    return { sharedState: null, units, unsplittable: {}, renumber: renumberByPosition };
  },
  project(answers: Answers, i, t: Thresholds, ctx: ProjectCtx) {
    const l = layoutOf(i);
    const parts = l.parts.map((part, j): UnitRow => {
      const got = NAMES.map((n) => answers[indexKey(n, j)]);
      const bad = got.find((a) => !a?.ok);
      const none = { part, failure_class: null, regression: null, severity: null, evidence_sufficient: null, mixed_chunks: false };
      if (bad !== undefined || got.some((a) => a === undefined)) {
        return { ...none, invalid: bad === undefined ? "no answer" : (bad as { reason: string }).reason };
      }
      // Why checked here: SCORE_POLICY makes probabilities optional for every question (one setting per spec, plan §6), but plan §6 requires them for a choice (fail closed); without them the sum and tie checks never ran.
      if ((((got[0] as { answer: unknown }).answer) as ChoiceAnswer).probabilities === undefined) return { ...none, invalid: "probabilities are required for the class" };
      const val = (n: number): unknown => (got[n] as { answer: unknown }).answer;
      const sev = (val(2) as ScoreAnswer).score;
      return {
        part,
        failure_class: (val(0) as ChoiceAnswer).choice as FailureClass,
        regression: (val(1) as NoulAnswer).noul,
        severity: { score: sev, level: SEVERITY[Math.round(sev)]! },
        evidence_sufficient: (val(3) as NoulAnswer).noul,
        invalid: null,
        // Why: the fan-out merges chunks per question key, so the four answers of a chunked part can come from different chunks; unknown (no chunk data) is reported as false.
        mixed_chunks: new Set(NAMES.map((n) => ctx.chunks?.[indexKey(n, j)]?.best_chunk).filter((c) => c !== undefined)).size > 1,
      };
    });
    // Plan §9 merge: the highest regression probability decides; the failing blocks come first, so a tie goes to them.
    const answered = parts.filter((p) => p.invalid === null);
    const top = answered.reduce<UnitRow | undefined>((best, p) => (best === undefined || p.regression! > best.regression! ? p : best), undefined);
    const invalid = parts.filter((p) => p.invalid !== null).map((p) => ({ part: p.part, reason: p.invalid! }));
    return {
      failing_blocks: l.failing,
      failure_class: top?.failure_class ?? null,
      regression: top?.regression ?? null,
      severity: top?.severity ?? null,
      evidence_sufficient: top?.evidence_sufficient ?? null,
      mixed_chunks: top?.mixed_chunks ?? false,
      likely_regression: top !== undefined && top.regression! >= t.regression!,
      // Why unanswered counts as insufficient: a part nobody judged may hold the failure, so silence must not read as a pass. A log that shows no failure has nothing to explain.
      insufficient: invalid.length > 0 || top === undefined || (top.failure_class !== DEFAULT_CLASS && top.evidence_sufficient! < t.evidence!),
      parts,
      invalid,
    };
  },
  // Plan §9: regression >= threshold or insufficient evidence.
  attention: (r) => r.likely_regression || r.insufficient,
};
