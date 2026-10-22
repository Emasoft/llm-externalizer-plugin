// SP-10 (TRDD-N2TDAXL4), plan §9 `classify audit` ("4 checks + absence, max-gated, wrong_at 0.7"): extracted values are audited against their source. Semantics ported from jev-mcp jev_audit (server.ts:1296-1456): per value FOUR failure-mode checks, or the omission (absence) check ALONE when the value is empty, never five; true = something wrong, so one max gate routes the record. Question wording is our own (D17).
import { z } from "zod";
import { noul, type Question } from "../l1/questions.js";
import { DEFAULT_POLICY } from "../l1/validate.js";
import { estimateTokens } from "../l1/estimate.js";
import { ENDPOINT_PROMPT_TOKENS } from "../l0/model.js";
import { buildEvidence, cutToTokens } from "../l2/evidence.js";
import { ENVELOPE_TOKENS } from "../l2/planner.js";
import { IdError, indexKey } from "../l2/ids.js";
import { maxGate, PolicyError } from "../l2/policy-kit.js";
import { dataGuard, noulOf, positionalIds, renumberByPosition } from "./shared.js";
import type { Answers, Built, BuiltUnit, DecisionSpec, ProjectCtx, Thresholds } from "./spec.js";

// WHY a cap here and not in the planner: the planner never truncates (plan §5: "audit, whole-diff review (`--claims` included) and extract truncate-and-flag in `build` (per jev-mcp), and the incomplete-context policy demotes `auto` to `review`"); the flag later demotes `pass` to `review` (E67).
// WHY tokens and not characters: the endpoint takes about 32,000 tokens (Amendment E) and non-ASCII text costs one token per character (l1/estimate.ts), so 60,000 characters of CJK would be refused instead of cut. `build` receives no model limits, so the number is fixed: 16,000 estimated tokens leaves half of the 32,000 for the records (a record is its request and value, at most the caps below, plus FOUR check questions of about 100 tokens each, or one absence question), the envelope and the JSON escaping the estimate already counts. Exact sizing would need the model limits passed to `build` (contextTokens, envelopeTokens).
export const SOURCE_MAX_TOKENS = 16_000;

// WHY a re-export: the one token-aware cut now lives in l2/evidence.ts (extract needs it too, and l2 cannot import a catalog file); review.ts and check.ts still import it from here.
export { cutToTokens };

/**
 * Refuses a built job whose single request cannot fit `limit` estimated tokens, naming what to do. The planner would refuse too, but with a message that does not tell the user which run parameter to change.
 * `limit` is the endpoint context (32,000, Amendment E) minus the 64-token envelope the planner reserves.
 */
// WHY derived from two exported figures: `build` is not given the model limits (spec.ts `build(i, t)` is the one contract every spec shares), so it uses the endpoint figure (l0/model.ts) minus the planner's envelope, each exported by the module that owns it.
export const REQUEST_TOKEN_LIMIT = ENDPOINT_PROMPT_TOKENS - ENVELOPE_TOKENS;

/** The planner's own figure for one request holding the whole job (planner.ts:56 and :215: `estimateTokens(JSON.stringify({state, questions}))`), without the envelope. */
export function requestTokens(b: Built): number {
  const questions = Object.assign({}, ...b.units.map((u) => u.questions), b.unsplittable) as Record<string, Question>;
  return estimateTokens(JSON.stringify({ state: { shared: b.sharedState, units: b.units.map((u) => u.state) }, questions }));
}
export function assertFits(b: Built, advice: string): void {
  const tokens = requestTokens(b);
  if (tokens > REQUEST_TOKEN_LIMIT) throw new PolicyError(`this run needs one request of about ${tokens} tokens but the limit is ${REQUEST_TOKEN_LIMIT}: ${advice}`);
}

// jev-mcp lib.ts:206 caps a call at 32 records.
const MAX_RECORDS = 32;
// The reference caps a request at 500 and a value at 2,000 CHARACTERS (jev-mcp lib.ts:209-212; any cut sets `truncated`, server.ts:1388). Ours are token caps because non-ASCII text costs a token per character (l1/estimate.ts); they are DERIVED so a request or value the reference accepts whole is never cut when it is ASCII letters: the estimate of the JSON form of that many letters (quotes included). Text that costs more per character (CJK, punctuation) is cut earlier than the reference would, which is the point of a token cap.
const lettersTokens = (chars: number): number => estimateTokens(JSON.stringify("a".repeat(chars)));
const REQUEST_MAX_TOKENS = lettersTokens(500);
const VALUE_MAX_TOKENS = lettersTokens(2_000);

const input = z
  .strictObject({
    source: z.string().refine((s) => s.trim() !== "", "source must not be blank"),
    // The caller already holds only part of the source (a line range or head read): counts as truncated (L2-09).
    partial: z.boolean().optional(),
    records: z
      .array(
        z.strictObject({
          id: z.string().optional(),
          // What was to be extracted, and the extracted value, verbatim; empty when the extractor returned nothing (server.ts:1346-1372).
          request: z.string().refine((s) => s.trim() !== "", "request must not be blank"),
          value: z.string(),
        }),
      )
      .min(1)
      .max(MAX_RECORDS),
  })
  .superRefine((v, ctx) => {
    try {
      positionalIds(v.records, "json");
    } catch (e) {
      if (!(e instanceof IdError)) throw e;
      ctx.addIssue({ code: "custom", message: e.message });
    }
  });
export type AuditInput = z.infer<typeof input>;

const CHECKS = ["hallucinated", "off_target", "incomplete", "format"] as const;
type CheckName = (typeof CHECKS)[number] | "absence";

export interface AuditRow {
  id: string;
  status: "ok" | "invalid_response";
  checks: Partial<Record<CheckName, number>>;
  // null when any answer was unreadable (server.ts:1423).
  p_wrong: number | null;
  action: "ok" | "wrong" | "invalid_response";
  reason: string;
  // Questions that got no usable answer, with the reason the fan-out or the validator gave.
  unanswered: { check: CheckName; reason: string }[];
}
export interface AuditResult {
  action: "pass" | "review" | "escalate";
  wrong_at: number;
  truncated: boolean;
  summary: { records: number; flagged: number; invalid: number };
  records: AuditRow[];
}

const isEmpty = (value: string): boolean => value.trim() === "";
const namesOf = (value: string): CheckName[] => (isEmpty(value) ? ["absence"] : [...CHECKS]);

function recordQuestions(k: number, value: string): Record<string, Question> {
  // WHY the guard names both: the source and the record are untrusted text in the state; each judgment is about them, never an order from them (D5, index-scoped).
  const guard = ` ${dataGuard(`\`shared.sources[0]\` and \`units[${k}]\``, "audit")}`;
  const val = `\`units[${k}].value\``;
  const req = `\`units[${k}].request\``;
  const src = "`shared.sources[0]`";
  const q = (text: string, yes: string, no: string): Question => noul(`${text}${guard}`, { true: yes, false: no });
  // WHY every check is framed so true = something is wrong: one max gate then routes the record, and a mean would dilute a fired flag (server.ts:1292-1295).
  if (isEmpty(value)) {
    // WHY a statement to judge, true = wrong (jev-mcp server.ts:1322-1327 asks "does the source contain what the request asks for, making the empty result wrong?"; same meaning, no premise inside the question).
    return { [indexKey("absence", k)]: q(`${src} contains what ${req} asks for, so the empty ${val} is a wrongly omitted result.`, "A value was wrongly omitted", "Returning nothing is correct") };
  }
  return {
    [indexKey("hallucinated", k)]: q(`${val} is not backed by ${src}, or the source does not contain it. Judge only from the source text, not from world knowledge.`, "The value is not in the source", "The source backs the value"),
    [indexKey("off_target", k)]: q(`${src} does not really provide what ${req} asks for, so ${val} came from incidental text.`, "The source does not truly provide this value", "The source truly provides this value"),
    [indexKey("incomplete", k)]: q(`${val} leaves out something that ${src} provides for ${req}.`, "The value misses part of what the source provides", "The value captures what the source provides"),
    [indexKey("format", k)]: q(`${val} breaks a format or constraint implied by ${req} (for example a date format, a unit or an allowed set of values).`, "The value breaks the implied format or constraint", "The value meets the implied format and constraints"),
  };
}

function build(i: AuditInput, _t: Thresholds): Built {
  const ids = positionalIds(i.records, "json");
  const cut = cutToTokens(i.source, SOURCE_MAX_TOKENS);
  // WHY partial carries the cut: buildEvidence derives the truncated flag from it, one source of truth for shared state and Built.truncated.
  const { sharedState, ctx } = buildEvidence([{ label: "source", text: cut.text, partial: i.partial === true || cut.cut }]);
  let recordCut = false;
  const units: BuiltUnit[] = i.records.map((r, k) => {
    // WHY trim before the cut: leading whitespace could otherwise eat the whole cap and leave a blank value that still gets the four checks (the question set follows emptiness, below). The reference also tests emptiness on the trimmed value (server.ts:1397).
    const request = cutToTokens(r.request.trim(), REQUEST_MAX_TOKENS);
    const value = cutToTokens(r.value.trim(), VALUE_MAX_TOKENS);
    recordCut ||= request.cut || value.cut;
    // WHY the question set follows the trimmed value: a non-blank value stays non-blank after the cut (it starts with text), so it never gets the four checks as a blank string.
    return { kind: "atomic", state: { id: ids[k], request: request.text, value: value.text }, questions: recordQuestions(k, r.value) };
  });
  // WHY renumberByPosition: the wire state is {shared, units:[...]}, so `units[k]` must name the record's place inside ITS request, whatever the job-wide index was (plan §5 renumber).
  return { sharedState, units, unsplittable: {}, renumber: renumberByPosition, truncated: ctx.truncated || recordCut };
}

function project(answers: Answers, i: AuditInput, t: Thresholds, ctx: ProjectCtx): AuditResult {
  const ids = positionalIds(i.records, "json");
  const records = ids.map((id, k): AuditRow => {
    const names = namesOf(i.records[k]!.value);
    const checks: Partial<Record<CheckName, number>> = {};
    // WHY a reason per unreadable answer: a failed or unsent request must name which question went unanswered and why, never read as a clean record.
    const unanswered: AuditRow["unanswered"] = [];
    for (const n of names) {
      const a = answers[indexKey(n, k)];
      const p = noulOf(a);
      if (p === null) unanswered.push({ check: n, reason: a === undefined ? "missing: no answer was returned" : a.ok ? "answer is not a noul" : a.reason });
      else checks[n] = p;
    }
    // WHY invalid wins over a readable finding (server.ts:1423-1436): one unreadable answer makes the record's P(wrong) unknown, and an unknown must escalate rather than be partly trusted.
    if (unanswered.length > 0) {
      return { id, status: "invalid_response", checks, p_wrong: null, action: "invalid_response", reason: `${unanswered.length} question(s) unanswered: ${unanswered.map((u) => `${u.check} (${u.reason})`).join("; ")}`, unanswered };
    }
    const gate = maxGate(Object.values(checks), t["wrong-at"]!);
    const base = { id, status: "ok" as const, checks, p_wrong: gate.max, unanswered };
    if (!gate.gated) return { ...base, action: "ok", reason: "no check reached the gate" };
    const gatedBy = names.filter((n) => checks[n]! >= t["wrong-at"]!);
    // WHY say so: a finding in the visible part stands (a truncated source can only demote pass to review, server.ts:1445), but the text that corrects the record may sit in the cut part.
    return { ...base, action: "wrong", reason: `${gatedBy.join(", ")} at or above ${t["wrong-at"]}${ctx.truncated ? "; the source was truncated, so the correcting text may be in the cut part" : ""}` };
  });
  const flagged = records.filter((r) => r.action === "wrong").length;
  const invalid = records.filter((r) => r.action === "invalid_response").length;
  // Max-gated and fail closed (server.ts:1447): any flag or unreadable answer escalates the audit; E67: a truncated source demotes pass to review.
  const action = invalid > 0 || flagged > 0 ? "escalate" : ctx.truncated ? "review" : "pass";
  return { action, wrong_at: t["wrong-at"]!, truncated: ctx.truncated, summary: { records: records.length, flagged, invalid }, records };
}

export const spec: DecisionSpec<AuditInput, AuditResult> = {
  id: "audit",
  input,
  thresholds: {
    // Range 0.5-1 from jev-mcp server.ts:1370-1376: below 0.5 a record would be wrong when the model leans "not wrong".
    "wrong-at": { default: 0.7, min: 0.5, max: 1, help: "--wrong-at: a record's largest check probability at or above which its value is flagged wrong and the audit escalates" },
  },
  split: "per-item",
  injection: "index-scoped",
  validation: DEFAULT_POLICY,
  build,
  project,
  // Plan §9: attention is any action other than pass.
  attention: (r) => r.action !== "pass",
};
