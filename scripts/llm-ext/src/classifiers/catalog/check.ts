// SP-13 (TRDD-0JLI6PGT), plan §9 `classify check --preset` (D15): exactly two presets, each a label question per item over one shared preset state. The two presets and their labels come from Pleo2/awesome-jev-agent-skills (skills jev-review-diff and jev-test-coverage, MIT); the wording is our own (D17). No second preset system.
import { z } from "zod";
import { choice, type Question } from "../l1/questions.js";
import { DEFAULT_POLICY } from "../l1/validate.js";
import type { ChoiceAnswer } from "../l1/validate-choice.js";
import { IdError, indexKey } from "../l2/ids.js";
import { assertFits } from "./audit.js";
import { dataGuard, positionalIds } from "./shared.js";
import type { Answers, Built, DecisionSpec } from "./spec.js";

const item = z.strictObject({ id: z.string().optional(), text: z.string().trim().min(1) });
const nonBlank = z.string().trim().min(1);

const invariantInput = z.strictObject({
  preset: z.literal("invariant-check"),
  invariants: z.array(item).min(1),
  before: nonBlank,
  after: nonBlank,
  context: z.string().optional(),
});
const criterionInput = z.strictObject({
  preset: z.literal("criterion-vs-tests"),
  criteria: z.array(item).min(1),
  tests: z.array(z.strictObject({ scenario: nonBlank, assertion: nonBlank })).min(1),
});
const input = z.discriminatedUnion("preset", [invariantInput, criterionInput]).superRefine((v, ctx) => {
  try {
    positionalIds(itemsOf(v), "json");
  } catch (e) {
    if (!(e instanceof IdError)) throw e;
    ctx.addIssue({ code: "custom", message: e.message });
  }
});
export type CheckInput = z.infer<typeof input>;

const itemsOf = (i: CheckInput): { id?: string; text: string }[] => (i.preset === "invariant-check" ? i.invariants : i.criteria);

// WHY the positive label lives with the preset: "label other than positive" is the attention rule (plan §9), and each preset has its own good outcome.
const PRESETS = {
  "invariant-check": {
    positive: "preserved",
    labels: {
      preserved: "The change keeps the invariant true",
      violated: "The change breaks the invariant",
      insufficient: "The state holds too little to tell",
    },
  },
  "criterion-vs-tests": {
    positive: "covered",
    labels: {
      covered: "The assertions verify the whole criterion",
      partial: "The assertions verify only part of the criterion",
      missing: "No test exercises the criterion",
      insufficient: "The test evidence is too incomplete to judge",
    },
  },
} as const;

const KEY = "check";

export interface CheckRow {
  id: string;
  status: "ok" | "invalid_response";
  label: string | null;
  positive: boolean;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  tie: boolean;
  // Why the item has no label: the fan-out's or the validator's reason, or "missing".
  reason: string | null;
}
export interface CheckResult {
  preset: CheckInput["preset"];
  positive_label: string;
  rows: CheckRow[];
  counts: Record<string, number>;
}

function build(i: CheckInput): Built {
  // WHY the guard: every field of the preset state is untrusted text; each judgment is about it, never an order from it (D5, index-scoped).
  const guard = ` ${dataGuard("every field of the state", "judge")}`;
  const criteria: Record<string, string> = { ...PRESETS[i.preset].labels };
  const unsplittable: Record<string, Question> = {};
  itemsOf(i).forEach((_it, k) => {
    unsplittable[indexKey(KEY, k)] =
      i.preset === "invariant-check"
        ? choice(`Compared with \`shared.before\`, does \`shared.after\` preserve the invariant \`shared.invariants[${k}]\`, judged with \`shared.context\` (null means no extra context)?${guard}`, criteria)
        : choice(`Do the tests in \`shared.tests\` explicitly verify the criterion \`shared.criteria[${k}]\`?${guard}`, criteria);
  });
  const sharedState =
    i.preset === "invariant-check"
      ? { preset: i.preset, invariants: i.invariants.map((x) => x.text), before: i.before, after: i.after, context: i.context ?? null }
      : { preset: i.preset, criteria: i.criteria.map((x) => x.text), tests: i.tests };
  // WHY no units: plan §5 makes every question of a preset unsplittable, so the whole preset is one request or is refused, never cut.
  const built: Built = { sharedState, units: [], unsplittable };
  // WHY refuse here and not cut: plan §5 lists truncate-and-flag only for audit, whole-diff review and extract; a check's state is judged whole, so the user must shrink it.
  assertFits(built, "use fewer items per run, or smaller before/after/context/tests texts");
  return built;
}

function project(answers: Answers, i: CheckInput): CheckResult {
  const { positive } = PRESETS[i.preset];
  const ids = positionalIds(itemsOf(i), "json");
  const counts: Record<string, number> = Object.fromEntries([...Object.keys(PRESETS[i.preset].labels), "invalid"].map((l) => [l, 0]));
  const rows = ids.map((id, k): CheckRow => {
    const a = answers[indexKey(KEY, k)];
    if (!a?.ok) {
      counts.invalid!++;
      return { id, status: "invalid_response", label: null, positive: false, confidence: null, probabilities: null, tie: false, reason: a === undefined ? "missing: no answer was returned" : a.reason };
    }
    const c = a.answer as ChoiceAnswer;
    counts[c.choice] = (counts[c.choice] ?? 0) + 1;
    // WHY a tie is not positive: a tie for the top place means the model could not separate the labels, and "preserved" must not be read out of a coin flip.
    return { id, status: "ok", label: c.choice, positive: c.choice === positive && !c.tie, confidence: c.confidence ?? null, probabilities: c.probabilities ?? null, tie: c.tie, reason: null };
  });
  return { preset: i.preset, positive_label: positive, rows, counts };
}

export const spec: DecisionSpec<CheckInput, CheckResult> = {
  id: "check",
  // IN-04: --preset fills the union discriminant; no `cli`, so check stays JSON-only (a file argument is still refused). No hand-written enum check: the union schema refuses an unknown value itself.
  flags: [
    { flag: "--preset", property: "preset", field: "preset", help: "Which check: invariant-check or criterion-vs-tests (the JSON input must not hold `preset` too).", parse: (raw) => raw },
  ],
  input,
  thresholds: {},
  split: "whole-result",
  injection: "index-scoped",
  validation: DEFAULT_POLICY,
  build,
  project,
  // Plan §9: attention is any label other than the preset's positive one; an unanswered item has no label, so it counts.
  attention: (r) => r.rows.some((row) => !row.positive),
};
