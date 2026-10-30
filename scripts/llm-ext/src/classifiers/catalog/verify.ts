// SP-01 (TRDD-0G2IVEVU): the verify decision as one catalog file (plan §9 `classify verify`, §5 verify row, D5, D14).
// Wording of the questions is our own (D17): the jev-mcp text has no licence check yet.
import { z } from "zod";
import { choice, noul, type Question } from "../l1/questions.js";
import { VERIFY_POLICY } from "../l1/validate.js";
import type { ChoiceAnswer } from "../l1/validate-choice.js";
import { buildEvidence } from "../l2/evidence.js";
import { checkItemIds, indexKey } from "../l2/ids.js";
import { dataGuard, NONE, noulOf } from "./shared.js";
import type { Answers, Built, BuiltUnit, DecisionSpec, ProjectCtx, Thresholds } from "./spec.js";

const item = z.strictObject({ id: z.string().optional(), text: z.string().trim().min(1) });
const input = z.strictObject({
  claims: z.array(item).min(1),
  // `partial`: the caller already holds only part of the source, which counts as truncated (L2-09).
  evidence: z.array(item.extend({ partial: z.boolean().optional() })).min(1),
});
export type VerifyInput = z.infer<typeof input>;

export type Relation = "supports" | "contradicts" | "says_nothing";
export interface VerifyRow {
  id: string;
  claim: string;
  verdict: "verified" | "contradicted" | "unknown";
  relation: Relation | null;
  status: "ok" | "invalid_response";
  probabilities: Record<string, number> | null;
  confidence: number | null;
  action: "auto" | "review";
  /** Null on an answered row. On an invalid_response row: why the claim got no usable answer (invalid_response, not_sent_fatal, not_sent_budget, not_sent_timeout, aborted, or the validation reason). */
  reason: string | null;
  supporting_evidence: string | null;
  same_subject: number | null;
}
export interface VerifyResult {
  auto_accept: number;
  subject_at: number;
  summary: { verified: number; contradicted: number; unknown: number; needs_review: number };
  results: VerifyRow[];
}

// WHY a fixed sentinel label: the source question needs a "none of them" option; evidence options are index keys (`evidence_i<j>`), so a caller evidence id "none" can never collide with it (D14).
// WHY on every question: claim and source text are untrusted and sit in the state; this tells the model not to obey them (D5 index-scoped placement).
const ANTI_INJECTION = ` ${dataGuard("every field of the state", "evaluate")}`;

// WHY caller ids default to a positional name: ids are optional in the input, and checkItemIds then refuses a duplicate between a caller id and a default.
function ids(prefix: string, items: readonly { id?: string }[]): string[] {
  const out = items.map((x, k) => x.id ?? `${prefix}_${k}`);
  checkItemIds(out);
  return out;
}

function claimQuestions(k: number, sources: number): Record<string, Question> {
  const q: Record<string, Question> = {
    [indexKey("relation", k)]: choice(`How do the sources relate to claims[${k}]?${ANTI_INJECTION}`, {
      supports: "The sources state the claim or directly imply that it is true",
      contradicts: "The sources state the opposite of the claim or imply that it is false",
      says_nothing: "The sources do not address what the claim asserts, either way",
    }),
    [indexKey("subject", k)]: noul(`The sources contain the result of the very check, run, file or object that claims[${k}] is about.${ANTI_INJECTION}`, {
      true: "The sources hold the result of the very thing the claim is about",
      false: "The sources are about something other than what the claim is about",
    }),
  };
  // WHY only with 2+ sources: with one source the answer is known, so asking costs tokens and invites a wrong "none".
  if (sources > 1) {
    const options: Record<string, string | null> = {};
    for (let j = 0; j < sources; j++) options[indexKey("evidence", j)] = `The claim rests on sources[${j}]`;
    options[NONE] = "No single source holds the content the claim depends on";
    q[indexKey("source", k)] = choice(`Which source does claims[${k}] rest on?${ANTI_INJECTION}`, options);
  }
  return q;
}

// WHY claims[n] is rewritten: a request that holds units from `offset` on sees them at positions 0.., so a reference to claims[n] must become claims[n - offset] (E45).
function renumber(units: BuiltUnit[], offset: number): BuiltUnit[] {
  return units.map((u) => ({
    ...u,
    questions: Object.fromEntries(
      Object.entries(u.questions).map(([key, q]) => [key, { ...q, instructions: q.instructions.replace(/claims\[(\d+)\]/g, (_m, n: string) => `claims[${Number(n) - offset}]`) }]),
    ),
  }));
}

function build(i: VerifyInput, _t: Thresholds): Built {
  const claimIds = ids("claim", i.claims);
  const evidenceIds = ids("evidence", i.evidence);
  const { sharedState } = buildEvidence(i.evidence.map((e, j) => ({ label: evidenceIds[j]!, text: e.text, ...(e.partial === undefined ? {} : { partial: e.partial }) })));
  const units: BuiltUnit[] = i.claims.map((c, k) => ({ kind: "atomic", state: { id: claimIds[k]!, text: c.text }, questions: claimQuestions(k, i.evidence.length) }));
  return { sharedState, units, unsplittable: {}, renumber };
}

function project(answers: Answers, i: VerifyInput, t: Thresholds, ctx: ProjectCtx): VerifyResult {
  const claimIds = ids("claim", i.claims);
  const evidenceIds = ids("evidence", i.evidence);
  const rows = i.claims.map((c, k): VerifyRow => {
    const base = { id: claimIds[k]!, claim: c.text };
    const rel = answers[indexKey("relation", k)];
    // WHY unknown + review: an answer we cannot read must never become a verdict (fail closed).
    // WHY the reason is kept: a claim lost to a failed, unsent or aborted request must say which and why, or it reads as a plain unknown.
    if (!rel?.ok) return { ...base, verdict: "unknown", relation: null, status: "invalid_response", probabilities: null, confidence: null, action: "review", reason: rel?.reason ?? "no answer", supporting_evidence: null, same_subject: null };
    const r = rel.answer as ChoiceAnswer;
    const relation = r.choice as Relation;
    const sameSubject = noulOf(answers[indexKey("subject", k)]);
    let source: string | null;
    if (i.evidence.length === 1) source = evidenceIds[0]!;
    else {
      const s = answers[indexKey("source", k)];
      // WHY an invalid source is no source: the claim cannot be tied to an item, so nothing is auto-accepted on it.
      const picked = s?.ok ? (s.answer as ChoiceAnswer).choice : NONE;
      const j = evidenceIds.findIndex((_e, n) => indexKey("evidence", n) === picked);
      source = picked === NONE || j < 0 ? null : evidenceIds[j]!;
    }
    // WHY says_nothing has no supporting evidence: the sources do not address the claim, whatever the source question named.
    const supporting = relation === "says_nothing" ? null : source;
    let verdict: VerifyRow["verdict"];
    if (relation === "supports") verdict = "verified";
    // WHY unknown, never contradicted (E55): a contradiction needs a source about the claim's subject; without one the "opposite" may be about another thing.
    else if (relation === "contradicts") verdict = supporting !== null && sameSubject !== null && sameSubject >= t["subject-at"]! ? "contradicted" : "unknown";
    else verdict = "unknown";
    const confidence = r.confidence ?? null;
    // WHY the extra conditions: no confidence, no source or cut-off sources mean the verdict cannot be trusted unseen (incomplete-context policy: auto becomes review).
    const auto = verdict !== "unknown" && confidence !== null && confidence >= t.auto! && supporting !== null && !ctx.truncated;
    return { ...base, verdict, relation, status: "ok", reason: null, probabilities: r.probabilities ?? null, confidence, action: auto ? "auto" : "review", supporting_evidence: supporting, same_subject: sameSubject };
  });
  const count = (f: (r: VerifyRow) => boolean): number => rows.filter(f).length;
  return {
    auto_accept: t.auto!,
    subject_at: t["subject-at"]!,
    summary: { verified: count((r) => r.verdict === "verified"), contradicted: count((r) => r.verdict === "contradicted"), unknown: count((r) => r.verdict === "unknown"), needs_review: count((r) => r.action === "review") },
    results: rows,
  };
}

export const spec: DecisionSpec<VerifyInput, VerifyResult> = {
  id: "verify",
  input,
  thresholds: {
    auto: { default: 0.8, min: 0.5, max: 1, help: "relation confidence at or above which a grounded verdict is auto-accepted" },
    "subject-at": { default: 0.5, min: 0, max: 1, help: "same-subject probability a contradiction needs; lower and it is unknown" },
  },
  split: "per-item",
  injection: "index-scoped",
  // WHY reject: a present but malformed confidence on the relation answer must fail it, not be hidden (jev-mcp verify).
  validation: VERIFY_POLICY,
  build,
  project,
  attention: (r) => r.results.some((x) => x.action === "review" || x.verdict === "contradicted" || x.verdict === "unknown"),
};
