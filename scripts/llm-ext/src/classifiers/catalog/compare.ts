// SP-08 (TRDD-FPD1G0VB): the compare decision as one catalog file (plan §9 `classify compare`, §5 compare row, D5, D14, D17, D21).
// Ported rules: jev-mcp jev_compare (server.ts:1013-1102, lib.ts relations, marginOf, classificationDecision; MIT, SEC-01 commit 86eae78). Question wording is our own (D17).
import { z } from "zod";
import { choice } from "../l1/questions.js";
import { DEFAULT_POLICY } from "../l1/validate.js";
import type { ChoiceAnswer } from "../l1/validate-choice.js";
import { indexKey } from "../l2/ids.js";
import { marginMet } from "../l2/policy-kit.js";
import { checkedChoice, dataGuard, isBlank } from "./shared.js";
import type { Answers, Built, BuiltUnit, DecisionSpec, Thresholds } from "./spec.js";

// WHY 20000 and 10 (jev-mcp): they bound one request. There is no text unit, so the planner never chunks; the aspects are units but the unsplittable `overall` pulls them all into ONE request, so a lost request leaves every question unanswered (the declared split, per-item, still makes project name each one) and a pair that does not fit is refused, not cut.
const MAX_PASSAGE = 20000;
const MAX_ASPECTS = 10;

const passage = z.string().min(1).max(MAX_PASSAGE).refine((s) => !isBlank(s), "a passage must not be blank");
const compareInputSchema = z.strictObject({
  passage_a: passage,
  passage_b: passage,
  // Aspects are short caller parameters: they stay in the instructions (D5), hence the 200-character cap.
  aspects: z.array(z.string().min(1).max(200).refine((s) => !isBlank(s), "an aspect must not be blank")).max(MAX_ASPECTS).default([]),
  // WHY no cap (jev-mcp server.ts:1031 has none) and blank means absent: it sits in state, and a blank purpose would tell the model to use an empty reason.
  purpose: z.string().optional().transform((s) => (s === undefined || isBlank(s) ? undefined : s)),
});
export type CompareInput = z.output<typeof compareInputSchema>;

const RELATIONS = {
  same_fact: "Both passages state the same underlying fact or claim",
  contradicts: "The passages state opposing facts about the same subject",
  different_facts: "The passages discuss different subjects or make claims that do not overlap",
} as const;
// WHY separate wording (jev-mcp): at aspect level the third outcome mostly means a passage does not address the aspect at all, and the criterion must say so.
const ASPECT_RELATIONS = {
  same_fact: "Both passages make comparable statements about this aspect and they agree",
  contradicts: "Both passages address this aspect and their statements conflict",
  different_facts: "The passages do not both make a comparable statement about this aspect: at least one does not address it, or what they say does not overlap",
} as const;
type Relation = keyof typeof RELATIONS;

export interface RelationRow {
  relation: Relation | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  /** Gap between the top two relation probabilities. */
  margin: number | null;
  /** auto only when the top probability reaches `auto` and the margin reaches `margin`; every refused or unanswered question is review. */
  decision: "auto" | "review";
  /** Why the question has no usable answer (invalid_response, not_sent_fatal, not_sent_budget, not_sent_timeout, aborted, or the validation reason). */
  invalid: string | null;
}
export interface CompareResult {
  overall: RelationRow;
  aspects: (RelationRow & { aspect: string })[];
  thresholds: { auto: number; margin: number };
  invalid: { key: string; reason: string }[];
}

const aspectKey = (k: number): string => indexKey("aspect", k);

function build(i: CompareInput): Built {
  // Aspect questions are units (plan §5: unit = aspect); `overall` is unsplittable, so the planner sends everything in one request or refuses.
  const units: BuiltUnit[] = i.aspects.map((aspect, k) => ({
    kind: "atomic",
    // WHY null: the aspect is a short caller parameter and stays in the instructions (D5); the unit has no state of its own, the passages are shared.
    state: null,
    questions: { [aspectKey(k)]: choice(`Judging only the aspect ${JSON.stringify(aspect)} of the two passages in the state, which relation holds? ${dataGuard("the passages")}`, ASPECT_RELATIONS) },
  }));
  const purpose = i.purpose === undefined ? "" : " Use `shared.purpose` as the reason for the comparison.";
  return {
    // WHY null for no purpose: the planner refuses an undefined shared part because JSON would drop it.
    sharedState: { purpose: i.purpose ?? null, passage_a: i.passage_a, passage_b: i.passage_b },
    units,
    unsplittable: {
      overall: choice(`Do \`shared.passage_a\` and \`shared.passage_b\` state the same underlying fact, contradict each other, or discuss different facts?${purpose} ${dataGuard("the passages")}`, RELATIONS),
    },
  };
}

function row(a: Answers[string] | undefined, t: Thresholds): RelationRow {
  const none = (invalid: string): RelationRow => ({ relation: null, probabilities: null, confidence: null, margin: null, decision: "review", invalid });
  if (!a?.ok) return none(a?.reason ?? "no answer");
  const c = a.answer as ChoiceAnswer;
  // WHY the shared argmax check (jev-mcp validateChoiceAnswer): a chosen relation below the top probability, or with none, is a malformed answer, and the margin would compare the wrong pair or be NaN.
  const g = checkedChoice(c, "relation", spec.validation);
  if ("error" in g) return none(g.error);
  const probabilities: Record<string, number> = Object.assign(Object.create(null) as Record<string, number>, c.probabilities);
  return {
    relation: c.choice as Relation,
    probabilities,
    confidence: c.confidence ?? null,
    margin: g.top - (g.runnerUp ?? 0),
    // WHY !c.tie: a tie is a valid answer that must be looked at, even when the margin threshold is set to 0.
    decision: g.top >= t.auto! && !c.tie && marginMet(g.best, g.runnerUp, t.margin!) ? "auto" : "review",
    invalid: null,
  };
}

function project(answers: Answers, i: CompareInput, t: Thresholds): CompareResult {
  const overall = row(answers.overall, t);
  const aspects = i.aspects.map((aspect, k) => ({ aspect, ...row(answers[aspectKey(k)], t) }));
  const invalid = [{ key: "overall", r: overall }, ...aspects.map((a, k) => ({ key: aspectKey(k), r: a }))].flatMap((x) => (x.r.invalid === null ? [] : [{ key: x.key, reason: x.r.invalid }]));
  return { overall, aspects, thresholds: { auto: t.auto!, margin: t.margin! }, invalid };
}

export const spec: DecisionSpec<CompareInput, CompareResult> = {
  id: "compare",
  input: compareInputSchema,
  thresholds: {
    auto: { default: 0.85, min: 0, max: 1, help: "--auto: lowest top probability that makes a relation automatic" },
    margin: { default: 0.5, min: 0, max: 1, help: "--margin: lowest gap between the top two relation probabilities for an automatic relation" },
  },
  // WHY per-item: a lost request invalidates only the questions it carried; but `overall` is unsplittable, so in practice one request holds everything.
  split: "per-item",
  // Plan §9: the aspect sits in the instructions, the passages are state.
  injection: "params-in-instructions",
  validation: DEFAULT_POLICY,
  build,
  project,
  // Plan §9: review (which includes every invalid answer) on the overall relation or any aspect.
  attention: (r) => r.overall.decision === "review" || r.aspects.some((a) => a.decision === "review"),
};
