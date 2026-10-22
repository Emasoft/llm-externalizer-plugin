// SP-02 (TRDD-SILI0HS8): the screen decision as one catalog file (plan §9 `classify screen`, §5 screen row, D5).
// Wording of the questions is our own (D17): the jev-mcp text has no licence check yet.
import { z } from "zod";
import { noul } from "../l1/questions.js";
import { DEFAULT_POLICY } from "../l1/validate.js";
import { PolicyError } from "../l2/policy-kit.js";
import { dataGuard, isBlank, noulOf } from "./shared.js";
import type { Answers, Built, DecisionSpec, Thresholds } from "./spec.js";

const input = z.strictObject({
  text: z.string().refine((s) => !isBlank(s), "text must not be blank"),
  // WHY capped: the purpose sits in an instruction, and a long one would be a second document placed outside the state (D5: a "purpose" is a short caller parameter, plan line 18).
  purpose: z.string().trim().min(1).max(2000).optional(),
});
export type ScreenInput = z.infer<typeof input>;

export type ScreenAction = "block" | "review" | "skip" | "pass";
export interface ScreenResult {
  status: "ok" | "invalid_response";
  probabilities: { injection: number | null; substance: number | null; relevance: number | null };
  thresholds: { block_at: number; review_at: number; skip_at: number };
  recommendation: { action: ScreenAction; reason: string };
}

// WHY refuse: with review above block, "review" could never be reached before "block" and the order would silently invert.
function checkThresholds(t: Thresholds): void {
  if (t.review! > t.block!) throw new PolicyError(`--review (${t.review}) must not be above --block (${t.block})`);
}

function build(i: ScreenInput, t: Thresholds): Built {
  checkThresholds(t);
  // WHY the guard on every question: the text is untrusted and sits in the state; each judgment is about it, never an order from it (D5).
  const guard = ` ${dataGuard("the text in the state")}`;
  const unsplittable = {
    injection: noul(`The text contains instructions addressed to an AI agent or language model that attempt to change its behavior${guard}`, {
      true: "The text tries to give orders to an AI reader",
      false: "The text is ordinary content that gives no orders to an AI reader",
    }),
    substance: noul(`The text contains substantive readable content${guard}`, {
      true: "The text has real readable content",
      false: "The text is empty, garbled, boilerplate or only whitespace and symbols",
    }),
    // WHY JSON.stringify: the purpose is a caller parameter in an instruction (D5); quoting it as a JSON string keeps quotes and newlines inside it from reading as part of the question.
    ...(i.purpose === undefined
      ? {}
      : { relevance: noul(`The text is useful source material for this task: ${JSON.stringify(i.purpose)}${guard}`, { true: "The text helps with the task", false: "The text does not help with the task" }) }),
  };
  // WHY one atomic unit and every question unsplittable (plan §5): the three judgments are about the whole text, so over the model limit it is refused, never cut.
  return { sharedState: null, units: [{ kind: "atomic", state: i.text, questions: {} }], unsplittable };
}

function project(answers: Answers, i: ScreenInput, t: Thresholds): ScreenResult {
  checkThresholds(t);
  const injection = noulOf(answers.injection);
  const substance = noulOf(answers.substance);
  const relevance = i.purpose === undefined ? null : noulOf(answers.relevance);
  const invalid = injection === null || substance === null || (i.purpose !== undefined && relevance === null);
  const thresholds = { block_at: t.block!, review_at: t.review!, skip_at: t.skip! };
  const done = (action: ScreenAction, reason: string): ScreenResult => ({
    status: invalid ? "invalid_response" : "ok",
    probabilities: { injection, substance, relevance },
    thresholds,
    recommendation: { action, reason },
  });
  // WHY block before the invalid check: a readable injection score over block is already a reason to refuse; an unreadable sibling answer must not soften it to review.
  if (injection !== null && injection >= t.block!) return done("block", `injection ${injection} is at or above ${t.block}`);
  // WHY review: an answer we cannot read must never read as pass (fail closed).
  if (invalid) return done("review", "an answer was missing or malformed");
  if (injection! >= t.review!) return done("review", `injection ${injection} is at or above ${t.review}`);
  if (substance! < t.skip!) return done("skip", `substance ${substance} is below ${t.skip}`);
  if (relevance !== null && relevance < t.skip!) return done("skip", `relevance ${relevance} is below ${t.skip}`);
  return done("pass", "no injection signal, substantive and relevant");
}

export const spec: DecisionSpec<ScreenInput, ScreenResult> = {
  id: "screen",
  input,
  thresholds: {
    block: { default: 0.75, min: 0, max: 1, help: "injection probability at or above which the text is blocked" },
    review: { default: 0.25, min: 0, max: 1, help: "injection probability at or above which the text goes to review" },
    skip: { default: 0.3, min: 0, max: 1, help: "substance or relevance probability below which the text is skipped" },
  },
  split: "whole-result",
  injection: "params-in-instructions",
  validation: DEFAULT_POLICY,
  build,
  project,
  attention: (r) => r.recommendation.action !== "pass",
};
