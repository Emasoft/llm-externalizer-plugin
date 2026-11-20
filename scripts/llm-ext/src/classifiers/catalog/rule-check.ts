// TRDD-LFTQCFUX: `classify rule-check`. A new phrase is compared with a list of existing rules, and the command says whether the phrase DUPLICATES one of them, is an UPDATED VERSION of one, or is NEW. Two questions per rule, both about the pair (phrase, rule): the relation (a choice) and whether the phrase contradicts the rule (a noul). Question text is our own wording (D17). The outcome is decided in code from the per-rule answers, never by a model.
import { z } from "zod";
import { choice, noul } from "../l1/questions.js";
import { DEFAULT_POLICY, type NoulAnswer } from "../l1/validate.js";
import type { ChoiceAnswer } from "../l1/validate-choice.js";
import { indexKey } from "../l2/ids.js";
import { f2, type TextRender } from "../l2/render-text.js";
import { dataGuard, renumberByPosition } from "./shared.js";
import type { Answers, BuiltUnit, DecisionSpec, Thresholds } from "./spec.js";

// WHY wider than l2/ids.ts ID_PATTERN ([A-Za-z0-9_-]): rule ids of a PRRD look like G7.4 and S64.134, and the consumer expects them echoed back unchanged, so a dot and a colon are allowed. This is safe because a rule id never builds a question key (those use indexKey); it travels only in state and in the result.
const RULE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

export type Relation = "duplicate" | "updated_version" | "new";
// WHY fixed text: the relation descriptions are part of the question, never caller input.
const RELATION_CRITERIA: Record<Relation, string> = {
  duplicate: "says the same thing as the rule",
  updated_version: "changes, extends or replaces the rule on the same subject",
  new: "is about a subject the rule does not cover",
};

const ruleCheckInput = z
  .strictObject({
    phrase: z.string().min(1),
    rules: z.array(z.strictObject({ id: z.string(), text: z.string().min(1) })).min(1),
    // The earlier messages of the conversation, background for every question; never scored.
    context: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.rules.forEach((r, k) => {
      const at = ["rules", k, "id"];
      if (!RULE_ID.test(r.id)) ctx.addIssue({ code: "custom", path: at, message: `invalid rule id ${JSON.stringify(r.id.length > 40 ? `${r.id.slice(0, 40)}...` : r.id)}: ids must match [A-Za-z0-9_.:-]{1,64}` });
      // WHY refused: callers index objects by rule id, and a plain object keyed by "__proto__" silently drops the entry.
      else if (r.id === "__proto__") ctx.addIssue({ code: "custom", path: at, message: 'a rule id may not be "__proto__"' });
      else if (seen.has(r.id)) ctx.addIssue({ code: "custom", path: at, message: `duplicate rule id ${JSON.stringify(r.id)}` });
      seen.add(r.id);
    });
  });
export type RuleCheckInput = z.output<typeof ruleCheckInput>;

export interface RuleRow {
  id: string;
  label: Relation | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  /** The contradiction answer: yes when its probability reaches --conflict; null when that question had no answer. */
  contradicts: { yes: boolean; probability: number } | null;
  /** True when the relation or the contradiction question of this rule has no valid answer. */
  unanswered: boolean;
  /** The reason of the first question that had no valid answer, else null. */
  invalid: string | null;
}
export type Outcome = "duplicate" | "updated_version" | "new" | "uncertain";
export interface RuleCheckResult {
  outcome: Outcome;
  /** The matched rule for duplicate and updated_version (the most confident one), else null. */
  rule_id: string | null;
  /** True when two or more rules qualify as updated_version, so rule_id is the best of several. */
  ambiguous: boolean;
  /** True when any answered rule is contradicted at or above --conflict, whatever its relation label. */
  conflict: boolean;
  reason: string;
  /** Ids of the rules that have no valid answer; any makes the outcome uncertain. */
  unanswered: string[];
  /** Every rule that is NOT a confident new without contradiction, least new first, unanswered last. */
  candidates: RuleRow[];
  /** How many rules are a confident new without contradiction; candidates.length + confident_new_count is the rule count. */
  confident_new_count: number;
}

const REL = "rel";
const CON = "con";

// WHY a confident label needs a known confidence: an unknown one goes to review, never to a verdict (label.ts: !(conf >= min)).
const confident = (r: RuleRow, min: number): boolean => r.label !== null && r.confidence !== null && r.confidence >= min;
const isConfidentNew = (r: RuleRow, min: number): boolean => !r.unanswered && r.label === "new" && confident(r, min) && r.contradicts?.yes !== true;
// WHY strictly greater: on equal confidence the rule listed first wins, so the result does not depend on the sort.
const best = (rows: RuleRow[]): RuleRow => rows.reduce((a, b) => (b.confidence! > a.confidence! ? b : a));

function buildRow(id: string, rel: Answers[string], con: Answers[string], conflict: number): RuleRow {
  const row: RuleRow = { id, label: null, confidence: null, probabilities: null, contradicts: null, unanswered: false, invalid: null };
  if (rel.ok) {
    const c = rel.answer as ChoiceAnswer;
    row.label = c.choice as Relation;
    row.confidence = c.confidence ?? null;
    row.probabilities = c.probabilities ? Object.assign(Object.create(null) as Record<string, number>, c.probabilities) : null;
  } else {
    row.unanswered = true;
    row.invalid = rel.reason;
  }
  if (con.ok) {
    const p = (con.answer as NoulAnswer).noul;
    row.contradicts = { yes: p >= conflict, probability: p };
  } else {
    row.unanswered = true;
    row.invalid ??= con.reason;
  }
  return row;
}

// WHY built from the result only: no model text reaches the reason, so it cannot carry an injected sentence.
function reasonOf(r: Omit<RuleCheckResult, "reason">, rows: RuleRow[], qualifying: number): string {
  const matched = rows.find((x) => x.id === r.rule_id);
  const at = matched?.confidence == null ? "" : ` (confidence ${f2(matched.confidence)})`;
  let base: string;
  if (r.outcome === "duplicate") base = `duplicate of ${r.rule_id}${at}`;
  else if (r.outcome === "updated_version") base = `updated version of ${r.rule_id}${at}${r.ambiguous ? `; ${qualifying} rules qualify` : ""}`;
  else if (r.outcome === "new") base = `new: all ${rows.length} rules are confidently new`;
  else if (r.unanswered.length > 0) base = `uncertain: ${r.unanswered.length} of ${rows.length} rules have no answer`;
  else base = `uncertain: no rule is a confident duplicate or updated version, and ${r.candidates.length} of ${rows.length} rules are not confidently new`;
  return r.conflict ? `${base}; the phrase contradicts ${rows.filter((x) => x.contradicts?.yes === true).length} rule(s)` : base;
}

function renderText(r: RuleCheckResult): TextRender {
  const lines = [`${r.outcome}${r.rule_id === null ? "" : ` ${r.rule_id}`}${r.ambiguous ? " · ambiguous" : ""}${r.conflict ? " · conflict" : ""}`];
  // WHY the unanswered rows are listed apart below: they have no full verdict to print as a candidate line.
  for (const c of r.candidates) if (!c.unanswered) lines.push(`${c.confidence === null ? "n/a" : f2(c.confidence)}  ${c.label}  ${c.id}${c.contradicts?.yes === true ? "  contradicts" : ""}`);
  lines.push(`${r.confident_new_count} rules are confidently new`);
  for (const c of r.candidates) if (c.unanswered) lines.push(`? no answer: ${c.id} (${c.invalid})`);
  return { lines };
}

export const spec: DecisionSpec<RuleCheckInput, RuleCheckResult> = {
  id: "rule-check",
  // WHY no `cli`: the input is structured (a phrase and a list of {id, text} rules), so it is JSON only.
  flags: [
    { flag: "--context", property: "context", field: "context", file: true, help: "File of earlier messages (- reads stdin) as background, never scored; sent with every request.", parse: (raw) => raw },
  ],
  input: ruleCheckInput,
  thresholds: {
    // WHY 0.6 and never a forced label: a relation below this confidence is not a verdict, so a phrase that fits no rule confidently is "uncertain", not a guess.
    "min-confidence": { default: 0.6, min: 0, max: 1, help: "--min-confidence: a relation counts only when its confidence is at or above this; otherwise the rule stays a candidate" },
    conflict: { default: 0.6, min: 0, max: 1, help: "--conflict: the phrase contradicts a rule when the contradiction probability is at or above this" },
  },
  split: "per-item",
  injection: "index-scoped",
  validation: DEFAULT_POLICY,
  build(i) {
    // WHY (TRDD-4DFR9FTX, after TRDD-7ZA3EE6Z and TRDD-WYY3SPDX): the old text put `shared.context` in the guard subject ("as data to judge") and added "Use `shared.context` as background.", so the earlier messages were themselves judged, against the USER design of 2026-11-18 ("must not evaluate/classify the context part, but only the input part"). With a context the question now says the context is background, never judged, and that only the phrase and the rule are judged. Without a context the text is byte-identical to before (pinned in rule-check.test.ts).
    // TRDD-0W932B0H: shared.context holds untrusted earlier messages, so it stays inside an injection guard (dataGuard(..., "read")).
    const units: BuiltUnit[] = i.rules.map((r, k) => {
      const subject = `\`shared.phrase\` and the rule in \`units[${k}]\``;
      const guard = i.context === undefined
        ? dataGuard(subject)
        : `\`shared.context\` is background for reading ${subject}. ${dataGuard("`shared.context`", "read")} Never judge or classify it. Judge only ${subject}. ${dataGuard(subject)}`;
      return {
        kind: "atomic",
        state: { id: r.id, text: r.text },
        // D5, D14: the questions name the rule by position and the keys are built from the index; no rule text and no rule id reach the instructions.
        questions: {
          [indexKey(REL, k)]: choice(`How does \`shared.phrase\` relate to the existing rule in \`units[${k}]\`? Answer with the relation. ${guard}`, RELATION_CRITERIA),
          [indexKey(CON, k)]: noul(`Does \`shared.phrase\` contradict the rule in \`units[${k}]\`? ${guard}`),
        },
      };
    });
    return { sharedState: { phrase: i.phrase, context: i.context ?? null }, units, unsplittable: {}, renumber: renumberByPosition };
  },
  project(answers: Answers, i, t: Thresholds) {
    const keys = i.rules.flatMap((_, k) => [indexKey(REL, k), indexKey(CON, k)]);
    // E60: the runner returns one answer per asked question; any other key set means the answers do not belong to this input, and a result built from part of them could read as "new".
    const got = Object.keys(answers);
    if (got.length !== keys.length || !keys.every((k) => Object.hasOwn(answers, k))) {
      throw new Error(`internal error: rule-check answers name ${got.length} questions (${got.join(", ")}) but the input has ${keys.length}`);
    }
    const min = t["min-confidence"]!;
    const rows = i.rules.map((r, k) => buildRow(r.id, answers[indexKey(REL, k)]!, answers[indexKey(CON, k)]!, t.conflict!));
    // WHY stopped and failed runs need no code of their own (verified in l2/fan-out.ts): a request that was not sent (budget, command timeout, Ctrl-C) or that failed gives EVERY question key of its rules a not-ok answer (fail(), per-item split), so those rows arrive here as unanswered and the first rule below makes the outcome uncertain. A run-wide failure never reaches project (run-decision.ts conclude throws first).
    const unanswered = rows.filter((x) => x.unanswered).map((x) => x.id);
    const conflict = rows.some((x) => x.contradicts?.yes === true);
    const dup = rows.filter((x) => x.label === "duplicate" && confident(x, min));
    const upd = rows.filter((x) => x.label === "updated_version" && confident(x, min));
    let outcome: Outcome;
    let matched: RuleRow | undefined;
    // WHY unanswered first: a rule nobody judged may be the duplicate, so even a confident duplicate elsewhere cannot be reported as the answer.
    if (unanswered.length > 0) outcome = "uncertain";
    // WHY duplicate before updated_version: a phrase that repeats one rule and revises another is first of all a repeat; the revision stays visible in candidates.
    else if (dup.length > 0) { outcome = "duplicate"; matched = best(dup); }
    else if (upd.length > 0) { outcome = "updated_version"; matched = best(upd); }
    else if (rows.every((x) => x.label === "new" && confident(x, min))) outcome = "new";
    else outcome = "uncertain";
    // WHY not one row per rule: a PRRD list has hundreds of rules, and the reader needs the rules that matter plus how many were confidently new.
    const candidates = rows
      .filter((x) => !isConfidentNew(x, min))
      // WHY p(new) ascending, unanswered last: the least new rule is the likeliest duplicate; a row without probabilities counts as certainly new (1). Array sort is stable, so ties keep input order.
      .sort((a, b) => (a.unanswered ? 2 : (a.probabilities?.new ?? 1)) - (b.unanswered ? 2 : (b.probabilities?.new ?? 1)));
    const partial = { outcome, rule_id: matched?.id ?? null, ambiguous: outcome === "updated_version" && upd.length > 1, conflict, unanswered, candidates, confident_new_count: rows.length - candidates.length };
    return { ...partial, reason: reasonOf(partial, rows, upd.length) };
  },
  // An uncertain outcome, a choice among several updated versions, and a contradiction each need a person to look.
  attention: (r) => r.outcome === "uncertain" || r.ambiguous || r.conflict,
  renderText,
};
