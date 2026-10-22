// SP-14 (TRDD-OHLMZONY), plan §9 `classify findings`. Semantics ported from claude-jev (commit 06fe407f, src/domain/catalog/review.ts and src/application/review-findings.ts): the four questions (real, reachable, already handled, severity), the drop / keep_low / keep order of tests, the four-level severity scale, the intent being optional and the sort (verdict, then worst severity first). Wording is our own (D17). Our additions: judging a window of source lines instead of whole files (plan §5), keep_low without a question when no window can be sent (E71), and keep_low `unanswered` for a finding the run could not answer.
import { z } from "zod";
import { estimateTokens } from "../l1/estimate.js";
import { noul, score } from "../l1/questions.js";
import { SCORE_POLICY, type NoulAnswer } from "../l1/validate.js";
import type { ScoreAnswer } from "../l1/validate-score.js";
import { IdError, indexKey } from "../l2/ids.js";
import { dataGuard, isBlank, positionalIds, renumberByPosition } from "./shared.js";
import type { Answers, BuiltUnit, DecisionSpec, Thresholds } from "./spec.js";

const nonBlank = z.string().refine((s) => !isBlank(s), "must not be blank");

const findingsInput = z
  .strictObject({
    // Untrusted text (D5): task, intent, finding texts and source texts all travel in state, never in instructions.
    task: nonBlank,
    // Reference (claude-jev review-findings.ts): the intent is optional.
    intent: nonBlank.optional(),
    // Lines kept on each side of the finding's line.
    window: z.number().int().min(0).max(100).default(10),
    // The caller reads the files (C4-01); this spec stays pure. A finding whose file is absent here has an empty window (E71).
    sources: z.array(z.strictObject({ file: z.string().min(1), text: z.string() })).default([]),
    findings: z.array(z.strictObject({ id: z.string().optional(), file: z.string().min(1), line: z.number().int().min(1), text: nonBlank, failure: nonBlank.optional() })).min(1),
  })
  .superRefine((v, ctx) => {
    const files = v.sources.map((s) => s.file);
    if (new Set(files).size !== files.length) ctx.addIssue({ code: "custom", message: "duplicate source file" });
    try {
      positionalIds(v.findings, "json");
    } catch (e) {
      if (!(e instanceof IdError)) throw e;
      ctx.addIssue({ code: "custom", message: e.message });
    }
  });

export type FindingsInput = z.output<typeof findingsInput>;
type Finding = FindingsInput["findings"][number];

export type Verdict = "keep" | "keep_low" | "drop";
export type SkipReason = "file_not_supplied" | "line_past_end" | "window_too_large";
export type FindingReason = "kept" | SkipReason | "not_real" | "already_handled" | "not_reachable" | "unanswered";

// Why a unit cap of our own: the planner refuses the WHOLE job when one atomic unit cannot fit a request (planner.ts unit-too-large), so one very long line would stop every finding. The reference has no such cap (it refuses a file above its byte limit). OPEN: the value is ours, not from the plan.
const MAX_UNIT_TOKENS = 20000;
// Same four levels as the reference (claude-jev review.ts SEVERITY_LEVELS), our own wording.
const SEVERITY = ["cosmetic", "minor", "major", "critical"] as const;

export interface FindingRow {
  id: string;
  file: string;
  line: number;
  verdict: Verdict;
  reason: FindingReason;
  real: number | null;
  reachable: number | null;
  already_handled: number | null;
  severity: { score: number; level: (typeof SEVERITY)[number]; confidence: number | null } | null;
  /** Why the finding has no usable answer (invalid_response, not_sent_fatal, not_sent_budget, aborted, or the validation reason); null otherwise. */
  invalid: string | null;
}
export interface FindingsResult {
  /** keep first, then keep_low, then drop; input order inside each group. */
  rows: FindingRow[];
  byId: Record<string, FindingRow>;
  counts: Record<Verdict, number>;
  invalid: { id: string; reason: string }[];
}

const NAMES = ["real", "reachable", "handled", "severity"] as const;
const ORDER: Record<Verdict, number> = { keep: 0, keep_low: 1, drop: 2 };

// The numbered lines around each finding, or why there is none (E71, and a window too large to send).
// Why memoised per input object and split once per source: build and project both need every window, and 50 findings in one file must not re-split it 100 times.
type Window = { text: string; skip: null } | { text: ""; skip: SkipReason };
const windows = new WeakMap<FindingsInput, Window[]>();
function windowsOf(i: FindingsInput): Window[] {
  const known = windows.get(i);
  if (known !== undefined) return known;
  const split = new Map<string, string[]>();
  for (const src of i.sources) {
    const lines = src.text.split(/\r?\n/);
    // Why drop the last empty piece: "a\nb\n" has two lines, not three.
    if (lines.at(-1) === "") lines.pop();
    split.set(src.file, lines);
  }
  const out = i.findings.map((f: Finding): Window => {
    const lines = split.get(f.file);
    if (lines === undefined) return { text: "", skip: "file_not_supplied" };
    if (f.line > lines.length) return { text: "", skip: "line_past_end" };
    const from = Math.max(1, f.line - i.window);
    const to = Math.min(lines.length, f.line + i.window);
    const text = lines.slice(from - 1, to).map((l, k) => `${from + k}: ${l}`).join("\n");
    return estimateTokens(text) + estimateTokens(f.text) + estimateTokens(f.failure ?? "") > MAX_UNIT_TOKENS ? { text: "", skip: "window_too_large" } : { text, skip: null };
  });
  windows.set(i, out);
  return out;
}

export const spec: DecisionSpec<FindingsInput, FindingsResult> = {
  id: "findings",
  input: findingsInput,
  thresholds: {
    real: { default: 0.5, min: 0, max: 1, help: "--real: lowest p that the finding is a real problem; below it the finding is dropped" },
    reachable: { default: 0.7, min: 0, max: 1, help: "--reachable: lowest p that the problem can happen; below it a real finding is kept with low confidence" },
    "already-handled": { default: 0.4, min: 0, max: 1, help: "--already-handled: p at or above which the finding is dropped as already handled" },
  },
  split: "per-item",
  injection: "index-scoped",
  // Why SCORE_POLICY: the only score here is the severity, and a reply without its probability list is still a usable level.
  validation: SCORE_POLICY,
  build(i) {
    const ids = positionalIds(i.findings, "json");
    const ws = windowsOf(i);
    const units: BuiltUnit[] = [];
    i.findings.forEach((f, k) => {
      const window = ws[k]!.text;
      // Why not asked (E71): with no source lines there is nothing to judge, and a window too large to send would make the planner refuse the whole job; project gives keep_low with the reason, without a question.
      if (ws[k]!.skip !== null) return;
      // Why the position and not k in the instruction: units that were not built leave gaps, and `units[j]` must name the place in the built list (the planner renumbers it per request).
      const at = `units[${units.length}]`;
      const guard = dataGuard(`\`shared\` and \`${at}\``);
      const about = `the finding in \`${at}.finding\`, judged on \`${at}.window\` (the numbered source lines around line \`${at}.line\` of \`${at}.file\`), for the task and intent in \`shared\``;
      units.push({
        kind: "atomic",
        state: { id: ids[k], file: f.file, line: f.line, finding: f.text, failure: f.failure ?? null, window },
        questions: {
          // Why the failure caveat (reference): the reviewer's account of the consequence is a claim to check, not evidence.
          [indexKey("real", k)]: noul(`Is ${about} a real problem in the code shown?${f.failure === undefined ? "" : ` \`${at}.failure\` is the reviewer's claim about the consequence, not evidence.`} ${guard}`, {
            true: "The shown code has the stated problem",
            false: "The shown code does not have it, or the claim describes intended behaviour",
          }),
          [indexKey("reachable", k)]: noul(`Can the problem described by ${about} actually happen when the code runs? ${guard}`, {
            true: "Some ordinary caller or input path reaches it",
            false: "Dead code, an unreachable branch, or a path no caller can take",
          }),
          [indexKey("handled", k)]: noul(`Is the problem described by ${about} already handled by the code shown (a check, a guard, a fallback)? ${guard}`, {
            true: "A guard present in the shown code prevents it",
            false: "No such guard is shown",
          }),
          [indexKey("severity", k)]: score(`How serious is the problem described by ${about}, if it is real? ${guard}`, [
            "Cosmetic: only wording, formatting or style; behaviour is unchanged.",
            "Minor: output or logs degrade, but the caller still gets a usable result.",
            "Major: an ordinary input gives a wrong result or an unhandled error.",
            "Critical: data is lost or corrupted, or an attacker gains access.",
          ]),
        },
      });
    });
    return { sharedState: { task: i.task, intent: i.intent ?? null }, units, unsplittable: {}, renumber: renumberByPosition, ...(units.length === 0 ? { noCall: true as const } : {}) }; // WHY noCall (E65): every window empty is a design outcome (project gives keep_low with the reason), not a build bug
  },
  project(answers: Answers, i, t: Thresholds) {
    const ids = positionalIds(i.findings, "json");
    // Why null-prototype maps: caller ids may be "__proto__" or "constructor" (E58 rule).
    const byId: Record<string, FindingRow> = Object.create(null);
    const ws = windowsOf(i);
    const none = { real: null, reachable: null, already_handled: null, severity: null };
    const rows = i.findings.map((f, k): FindingRow => {
      const base = { id: ids[k]!, file: f.file, line: f.line };
      let row: FindingRow;
      if (ws[k]!.skip !== null) row = { ...base, verdict: "keep_low", reason: ws[k]!.skip!, ...none, invalid: null };
      else {
        const got = NAMES.map((n) => answers[indexKey(n, k)]);
        const bad = got.find((a) => !a?.ok);
        // Why keep_low and not drop: a finding nobody could judge must stay visible; the reason names why it is unanswered.
        if (bad !== undefined || got.some((a) => a === undefined)) {
          const reason = bad === undefined ? "no answer" : (bad as { reason: string }).reason;
          row = { ...base, verdict: "keep_low", reason: "unanswered", ...none, invalid: reason };
        } else {
          const p = (n: number): number => ((got[n] as { answer: unknown }).answer as NoulAnswer).noul;
          const real = p(0), reachable = p(1), handled = p(2);
          const sevAnswer = (got[3] as { answer: unknown }).answer as ScoreAnswer;
          const sev = sevAnswer.score;
          const verdict: Verdict = real < t.real! || handled >= t["already-handled"]! ? "drop" : reachable >= t.reachable! ? "keep" : "keep_low";
          const reason: FindingReason = real < t.real! ? "not_real" : handled >= t["already-handled"]! ? "already_handled" : reachable >= t.reachable! ? "kept" : "not_reachable";
          row = { ...base, verdict, reason, real, reachable, already_handled: handled, severity: { score: sev, level: SEVERITY[Math.round(sev)]!, confidence: sevAnswer.confidence ?? null }, invalid: null };
        }
      }
      byId[row.id] = row;
      return row;
    });
    const counts: Record<Verdict, number> = { keep: 0, keep_low: 0, drop: 0 };
    for (const r of rows) counts[r.verdict]++;
    // Reference byReviewPriority: keep, keep_low, drop; inside a group the worst severity leads (unjudged rows last); the sort is stable, so ties keep the input order.
    const sorted = [...rows].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || (b.severity?.score ?? -1) - (a.severity?.score ?? -1));
    return { rows: sorted, byId, counts, invalid: rows.filter((r) => r.invalid !== null).map((r) => ({ id: r.id, reason: r.invalid! })) };
  },
  // DELIBERATE WIDENING beyond the plan §9 row ("any keep"): any unjudged or unanswered finding also raises attention (no severity: empty window, file not supplied, line past end, window too large, unanswered).
  // WHY: a finding nobody examined must not leave the run looking clean, so --strict-exit fails when a finding's source was not supplied, or when a whole run's requests failed, even though no finding was kept.
  attention: (r) => r.rows.some((row) => row.verdict === "keep") || r.invalid.length > 0 || r.rows.some((row) => row.severity === null),
};
