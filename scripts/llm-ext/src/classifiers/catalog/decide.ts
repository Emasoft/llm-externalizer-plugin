// SP-06 (TRDD-N1FQ8A8K): the decide decision as one catalog file (plan §9 `classify decide`, §5 decide row, D1, D5, D14, D17, D21; E61, E62).
// Ported rules: jev-mcp jev_decide (server.ts:749-898, lib.ts escape hatches and contradictsRecommendation, MIT, SEC-01 commit 86eae78). Question wording is our own (D17).
// E61 (an escape option chosen gives `escaped`, attention): project returns status "escaped" for a hatch and `attention` is true for every status other than "selected".
// E62 replaces the reference's caps of 6 candidates and 3 requirements: the single limit is 19 questions in total (1 recommendation + candidates x requirements), checked in the input schema.
import { z } from "zod";
import { choice } from "../l1/questions.js";
import { DEFAULT_POLICY } from "../l1/validate.js";
import type { ChoiceAnswer } from "../l1/validate-choice.js";
import { IdError, checkItemIds } from "../l2/ids.js";
import { checkedChoice, dataGuard } from "./shared.js";
import type { Answers, Built, DecisionSpec } from "./spec.js";

// E62: one recommendation plus one relation check per (candidate, requirement) pair, all in one request because every check points at the shared state.
const MAX_QUESTIONS = 19;

// Plan §9: the escape options let the model decline to rank; texts are our own wording.
const ESCAPE_HATCHES = {
  ask_user: "A consequential preference or requirement is missing from the state, so the user should be asked instead of guessing",
  investigate: "Facts needed for a sound choice are missing from the state, so they should be gathered before choosing",
  none: "None of the listed options fits the known priorities",
} as const;
type Hatch = keyof typeof ESCAPE_HATCHES;
const isHatch = (k: string): k is Hatch => Object.hasOwn(ESCAPE_HATCHES, k);

const RELATIONS = {
  supported: "The evidence supports this requirement for this option",
  contradicted: "The evidence contradicts this requirement for this option, not merely some other requirement",
  unknown: "The evidence does not show whether this requirement holds for this option",
} as const;
type Relation = keyof typeof RELATIONS;

const decideInputSchema = z
  .strictObject({
    decision: z.string().min(1).max(1500),
    evidence: z.string().min(1).max(12000),
    priorities: z.string().min(1).max(2000),
    // WHY no 6/3 caps (jev-mcp MAX_CANDIDATES_DECIDE/MAX_REQUIREMENTS): the plan's rule is the 19-question total (E62), which those caps only implied; the count rule below is the single limit.
    candidates: z.array(z.strictObject({ id: z.string(), description: z.string().min(1).max(2000) })).min(2).max(MAX_QUESTIONS),
    requirements: z.array(z.string().min(1).max(500)).max(MAX_QUESTIONS).default([]),
    escape_hatches: z.boolean().default(true),
    escalate_on_contradiction: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    try {
      checkItemIds(v.candidates.map((c) => c.id));
    } catch (e) {
      if (!(e instanceof IdError)) throw e;
      ctx.addIssue({ code: "custom", message: e.message });
    }
    // WHY refuse a colliding id: the recommendation's answer is mapped back by key, and a candidate called like a hatch would be read as that hatch.
    const clash = v.escape_hatches ? v.candidates.find((c) => isHatch(c.id)) : undefined;
    if (clash) ctx.addIssue({ code: "custom", message: `candidate id "${clash.id}" collides with an escape option; rename it or set escape_hatches to false` });
    const questions = 1 + v.candidates.length * v.requirements.length;
    if (questions > MAX_QUESTIONS) ctx.addIssue({ code: "custom", message: `${v.candidates.length} candidates x ${v.requirements.length} requirements need ${questions} questions, over the limit of ${MAX_QUESTIONS}` });
  });

export type DecideInput = z.output<typeof decideInputSchema>;

export interface DecideCheck { candidate: string; requirement: number; answer: Relation | null; invalid: string | null }
export interface DecideResult {
  /** selected: a candidate was recommended; escaped: an escape option won; escalate: the recommendation was withdrawn; invalid: no usable recommendation. */
  status: "selected" | "escaped" | "escalate" | "invalid";
  selected: string | null;
  escape: Hatch | null;
  confidence: number | null;
  /** Keyed by candidate id (escape options by their name). */
  probabilities: Record<string, number> | null;
  /** 0-based indices of the requirements whose check contradicted the recommended candidate. */
  contradicted_requirements: number[];
  checks: DecideCheck[];
  warnings: string[];
  /** Questions with no usable answer and why (invalid_response, not_sent_fatal, not_sent_budget, aborted, or the validation reason). */
  invalid: { key: string; reason: string }[];
}

const optionKey = (i: number): string => `option_${i}`;
const checkKey = (i: number, j: number): string => `check_${i}_${j}`;

function build(i: DecideInput): Built {
  // WHY opaque option keys: caller ids stay out of the wire and out of the API's key rules (D14); project maps them back by position.
  const criteria: Record<string, string> = Object.fromEntries(i.candidates.map((c, k) => [optionKey(k), c.description]));
  if (i.escape_hatches) Object.assign(criteria, ESCAPE_HATCHES);
  const unsplittable = {
    // WHY the state is named and not quoted: decision, evidence and priorities are caller text of any length; the instruction only points at them and the guard says not to obey them (D5). The guard also names the option texts: the candidate descriptions sit in criteria, outside the state.
    recommendation: choice(
      `Which option best fits the decision in the state, given its evidence and priorities? ${i.escape_hatches ? "An escape option may be chosen when the state does not allow a sound choice. " : ""}Do not invent missing facts, preferences or approvals. ${dataGuard("the state and the option texts")}`,
      criteria,
    ),
    ...Object.fromEntries(
      i.candidates.flatMap((_, k) =>
        i.requirements.map((__, j) => [
          // WHY `shared.` paths: the planner sends the shared part as `state.shared` (l2/planner.ts RequestState), the same form compare and extract use.
          checkKey(k, j),
          choice(`How does the option \`shared.candidates[${k}]\` relate to \`shared.requirements[${j}]\`, judged on the evidence in the state? Judge only this requirement, not the overall merit of the option. Missing evidence is not a contradiction. ${dataGuard("the state")}`, RELATIONS),
        ]),
      ),
    ),
  };
  return {
    // Card: state = all inputs. Candidates are listed under their opaque key so `shared.candidates[k]` and the answer key agree.
    sharedState: { decision: i.decision, evidence: i.evidence, priorities: i.priorities, candidates: i.candidates.map((c, k) => ({ id: optionKey(k), description: c.description })), requirements: i.requirements },
    // WHY no units: every question reads the whole state, so all of them are unsplittable and travel in one request or the planner refuses (§5 decide row).
    units: [],
    unsplittable,
  };
}

function project(answers: Answers, i: DecideInput): DecideResult {
  const invalid: DecideResult["invalid"] = [];
  const checks: DecideCheck[] = i.candidates.flatMap((c, k) =>
    i.requirements.map((_, j) => {
      const a = answers[checkKey(k, j)];
      if (!a?.ok) {
        // WHY the reason is kept: a stopped or lost request must say which checks were not answered and why.
        invalid.push({ key: checkKey(k, j), reason: a?.reason ?? "no answer" });
        return { candidate: c.id, requirement: j, answer: null, invalid: a?.reason ?? "no answer" };
      }
      return { candidate: c.id, requirement: j, answer: (a.answer as ChoiceAnswer).choice as Relation, invalid: null };
    }),
  );
  const probabilities = (c: ChoiceAnswer): Record<string, number> | null => {
    if (!c.probabilities) return null;
    // WHY a null-prototype map: candidate ids are caller text and "__proto__" is a legal id.
    // WHY no range check on the keys: validateChoice (l1/validate-choice.ts:29) refuses a key that is not a criteria key, so only escape options and option_<k> in range arrive.
    const out: Record<string, number> = Object.create(null);
    for (const [key, p] of Object.entries(c.probabilities)) out[isHatch(key) ? key : i.candidates[Number(key.slice("option_".length))]!.id] = p;
    return out;
  };
  const failed = (reason: string): DecideResult => ({ status: "invalid", selected: null, escape: null, confidence: null, probabilities: null, contradicted_requirements: [], checks, warnings: [], invalid: [...invalid, { key: "recommendation", reason }] });

  const rec = answers.recommendation;
  if (!rec?.ok) return failed(rec?.reason ?? "no answer");
  const c = rec.answer as ChoiceAnswer;
  const chosen = checkedChoice(c, "option", spec.validation);
  if ("error" in chosen) return failed(chosen.error);

  const warnings: string[] = [];
  if (c.tie) warnings.push("The top two options are tied; inspect before acting");
  const base = { confidence: c.confidence ?? null, probabilities: probabilities(c), checks, invalid };
  if (isHatch(c.choice)) return { ...base, status: "escaped", selected: null, escape: c.choice, contradicted_requirements: [], warnings };

  const k = Number(c.choice.slice("option_".length));
  const own = checks.filter((x) => x.candidate === i.candidates[k]!.id);
  const contradicted = own.filter((x) => x.answer === "contradicted").map((x) => x.requirement);
  // WHY a separate list: a check with no usable answer is unknown, not contradicted; it must not be counted as either supported or contradicted.
  const unanswered = own.filter((x) => x.answer === null).map((x) => x.requirement);
  const list = (rs: number[]): string => `Requirement${rs.length > 1 ? "s" : ""} ${rs.map((r) => r + 1).join(", ")}`;
  if (contradicted.length > 0) warnings.push(`${list(contradicted)} contradicted by the recommended candidate; inspect before acting`);
  if (unanswered.length > 0) warnings.push(`${list(unanswered)} unanswered for the recommended candidate; inspect before acting`);
  // WHY withdraw and not re-select (jev-mcp): the flag only retracts the model's pick; choosing another candidate here would invent a recommendation nobody asked the model for. An unanswered check withdraws it too: the flag asks for a pick every check has cleared.
  const escalate = i.escalate_on_contradiction && (contradicted.length > 0 || unanswered.length > 0);
  return { ...base, status: escalate ? "escalate" : "selected", selected: escalate ? null : i.candidates[k]!.id, escape: null, contradicted_requirements: contradicted, warnings };
}

export const spec: DecisionSpec<DecideInput, DecideResult> = {
  id: "decide",
  input: decideInputSchema,
  // jev-mcp jev_decide has no numeric threshold: the policy is the escape options, the checks and the escalate flag, all input.
  thresholds: {},
  split: "whole-result",
  // Candidate descriptions and relation texts sit in criteria (plan §9); evidence and priorities are untrusted state the instructions only point at.
  injection: "index-scoped",
  validation: DEFAULT_POLICY,
  build,
  project,
  // Plan §9: escaped, escalate, invalid, warnings.
  attention: (r) => r.status !== "selected" || r.invalid.length > 0 || r.warnings.length > 0,
};
