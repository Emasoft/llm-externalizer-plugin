// SP-09 (TRDD-B19TVE91): the extract decision as one catalog file (plan §9 `classify extract`, §5 extract row, D5 and its extract exception, D14, D17, D21; E65, E66).
// Ported rules: jev-mcp jev_extract (server.ts:1111-1286, lib.ts caps; MIT, SEC-01 commit 86eae78). Question wording is our own (D17).
// A cut document makes every field `review` (plan §5): the value may sit in the part that was cut, so nothing is `found` or `not_found` on it.
// REGEX WORKER (SP-22, TRDD-DTDGVXWV): Jev only PICKS among regex matches, and the regexes run async in a worker thread, so the matches arrive inside the input as `field.matches`.
// Implemented in ../l2/regex-worker.ts: `runRegexes(text, fields, cap, { signal, timeoutMs })` (one worker, each field under its own 1000 ms deadline) and `runRegex(text, pattern, flags, cap, signal?)`, both returning
//   { candidates: string[]; truncated: boolean; tooLong: number; error: string | null }
// (flags: letters only, every g removed and exactly one g appended; matches deduplicated, empty ones dropped, ones over MAX_CANDIDATE_CHARS counted in tooLong and skipped,
// at most `cap` kept with truncated = true, `cap` being the candidate-cap threshold (2-100); a timeout or a bad pattern gives candidates [] and error = the message, E64).
// The runner calls `spec.prepare` ONCE before `build`, and prepare calls `withMatches(input, cap, { signal })` (exported below): it runs every field on `cutDocument(document).text`, the SAME string `build` sends, and stores the result as `field.matches` (tooLong -> too_long).
// `build` and `project` refuse a field without `matches`.
import { z } from "zod";
import { choice } from "../l1/questions.js";
import { DEFAULT_POLICY } from "../l1/validate.js";
import type { ChoiceAnswer } from "../l1/validate-choice.js";
import { buildEvidence } from "../l2/evidence.js";
import { IdError, checkItemIds, indexKey } from "../l2/ids.js";
import { marginMet, PolicyError } from "../l2/policy-kit.js";
import { MAX_CANDIDATE_CHARS, runRegexes, type RegexOptions } from "../l2/regex-worker.js";
import { SOURCE_MAX_TOKENS } from "./audit.js";
import { checkedChoice, dataGuard, isBlank } from "./shared.js";
import type { Answers, Built, BuiltUnit, DecisionSpec, ProjectCtx, Thresholds } from "./spec.js";

// WHY these caps (jev-mcp lib.ts): they bound one request; a document over the cap is cut and flagged in `build` (plan §5), never refused.
export const DOCUMENT_MAX_CHARS = 50_000;
const MAX_FIELDS = 32;
// WHY re-exported: the limit belongs to the worker that enforces it (l2 cannot import this layer); the schema below and other importers keep reading it from here.
export { MAX_CANDIDATE_CHARS };
/** Aggregate size of the candidate values sent in one request. */
const MAX_TOTAL_CANDIDATE_CHARS = 50_000;
const NONE_OF_THEM = "none_of_them";

const matchesSchema = z.strictObject({
  candidates: z.array(z.string().min(1).max(MAX_CANDIDATE_CHARS)),
  truncated: z.boolean().default(false),
  too_long: z.number().int().min(0).default(0),
  // WHY min(1): an empty message would be falsy; `error` is tested with `!== null` everywhere, so an empty string must not be able to mean "an error with no text".
  error: z.string().min(1).nullable().default(null),
});
const extractInputSchema = z
  .strictObject({
    document: z.string().refine((s) => !isBlank(s), "document must not be blank"),
    fields: z
      .array(
        z.strictObject({
          id: z.string(),
          // The pattern and flags are the input of `spec.prepare` to the regex worker (SP-22); this spec never runs them.
          pattern: z.string().min(1).max(500),
          // WHY letters only (SP-22): the regex worker refuses anything else as an error result; refusing at parse time names the field before any worker or request exists.
          flags: z.string().max(8).regex(/^[a-zA-Z]*$/, "flags must be letters only").optional(),
          // A short caller parameter: it stays in the instructions (D5).
          description: z.string().min(1).max(2000),
          // Filled by `spec.prepare` (the regex worker) before build; absent in the caller's own JSON.
          matches: matchesSchema.optional(),
        }),
      )
      .min(1)
      .max(MAX_FIELDS),
    // WHY no cap (jev-mcp server.ts:1135 has none) and blank means absent: it sits in state, and a blank purpose would tell the model to use an empty reason.
    purpose: z.string().optional().transform((s) => (s === undefined || isBlank(s) ? undefined : s)),
  })
  .superRefine((v, ctx) => {
    try {
      checkItemIds(v.fields.map((f) => f.id));
    } catch (e) {
      if (!(e instanceof IdError)) throw e;
      ctx.addIssue({ code: "custom", message: e.message });
    }
    for (const f of v.fields) {
      // WHY unique: a duplicate candidate would be two options with the same value, splitting the model's probability between them.
      if (f.matches && new Set(f.matches.candidates).size !== f.matches.candidates.length) ctx.addIssue({ code: "custom", message: `field ${JSON.stringify(f.id)} has duplicate candidates` });
    }
  });
export type ExtractInput = z.output<typeof extractInputSchema>;

export type ExtractStatus = "found" | "not_found" | "review" | "invalid_pattern" | "invalid";
export interface ExtractRow {
  id: string;
  /** Verbatim text of the document, never model-generated; null unless status is found, or review with a pick. */
  value: string | null;
  status: ExtractStatus;
  reason: string | null;
  confidence: number | null;
  top_probability: number | null;
  margin: number | null;
  candidates_considered: number;
  candidates_truncated: boolean;
  matches_skipped_too_long: number;
}
export interface ExtractResult {
  fields: ExtractRow[];
  /** Plan §9 status order: found, not_found, review, invalid_pattern, invalid. */
  summary: Record<ExtractStatus, number>;
  document_truncated: boolean;
  thresholds: { auto: number; margin: number; candidate_cap: number };
  /** Fields with no usable answer and why (invalid_response, not_sent_fatal, not_sent_budget, not_sent_timeout, aborted, or the validation reason). */
  invalid: { id: string; reason: string }[];
}

const fieldKey = (k: number): string => indexKey("f", k);

interface Prepared {
  id: string;
  description: string;
  candidates: string[];
  /** The worker stopped at its own cap, or this spec cut the list at the candidate cap (E66). */
  truncated: boolean;
  tooLong: number;
  error: string | null;
}

// WHY one cut: the regex worker (SP-22) must run on the very string the model reads, or a match could be text the model never sees. buildEvidence is the one place that cuts (plan §5).
// WHY also a token cap (audit's SOURCE_MAX_TOKENS): the document is atomic shared state sent with every request, so 50000 CJK or symbol characters (one token or more each) would exceed the request limit and the planner would refuse; cut and flag instead.
const evidenceOf = (document: string) => buildEvidence([{ label: "document", text: document }], { maxChars: DOCUMENT_MAX_CHARS, maxTokens: SOURCE_MAX_TOKENS });
/** The document as `build` sends it, and whether it was cut. SP-22 runs its regex on `.text`. */
export function cutDocument(document: string): { text: string; truncated: boolean } {
  const ev = evidenceOf(document);
  return { text: (ev.sharedState as { sources: { text: string }[] }).sources[0]!.text, truncated: ev.ctx.truncated };
}


/**
 * Fills `matches` of every field by running its regex on `cutDocument(i.document).text` (the string `build` sends) in ONE worker thread, each field under its own deadline (SP-22, regex-worker.ts).
 * The runner calls this once through `spec.prepare`, before `build`, after the cheap flag refusals and the -o directory check. A field that already carries `matches` is overwritten: the worker is the only source of that value.
 * The cut is done here (the regex runs on the cut text, never on `i.document`). Rejects with PolicyError for a bad cap, with the abort reason when `opts.signal` aborts, and with the worker constructor's error if no worker can be made.
 */
export async function withMatches(i: ExtractInput, cap: number, opts: RegexOptions = {}): Promise<ExtractInput> {
  // WHY here and a PolicyError: this is the first place the cap meets the regex worker; a bad --candidate-cap must end the run as exit 1 (a refusal), not as an internal RangeError.
  const range = spec.thresholds["candidate-cap"]!;
  if (!Number.isInteger(cap) || cap < range.min || cap > range.max) throw new PolicyError(`--candidate-cap must be a whole number from ${range.min} to ${range.max}, got ${cap}`);
  const results = await runRegexes(cutDocument(i.document).text, i.fields.map((f) => ({ pattern: f.pattern, flags: f.flags ?? "" })), cap, opts);
  // WHY throw: an abort is the user stopping the run, not a bad pattern; written into `matches.error` it would come out as invalid_pattern. The reason (an AbortError by default) reaches the runner as the abort it is.
  opts.signal?.throwIfAborted();
  // WHY the rename: the worker reports `tooLong`, the stored shape is snake_case (`too_long`).
  return { ...i, fields: i.fields.map((f, k) => ({ ...f, matches: { candidates: results[k]!.candidates, truncated: results[k]!.truncated, too_long: results[k]!.tooLong, error: results[k]!.error } })) };
}

// WHY one function for build and project: both must derive the same candidate list, or an answer key would name a different value than the one that was asked.
function prepare(i: ExtractInput, t: Thresholds): Prepared[] {
  const cap = t["candidate-cap"]!;
  if (!Number.isInteger(cap)) throw new PolicyError(`--candidate-cap must be a whole number, got ${cap}`);
  const cut = cutDocument(i.document).text;
  return i.fields.map((f) => {
    // WHY refuse: a field without matches would silently count as "no regex matches" and report not_found for a regex that never ran.
    if (!f.matches) throw new PolicyError(`field ${JSON.stringify(f.id)} has no regex matches; run the regex worker before build`);
    const m = f.matches;
    // WHY drop and flag, not refuse: `matches` comes from the caller's JSON, and "value is verbatim document text" holds only for candidates the model can read in the cut document; one bad field must not fail the call, but its list is no longer complete, so it can only be review.
    const present = m.candidates.filter((c) => cut.includes(c));
    const dropped = present.length !== m.candidates.length;
    // E66: the first `cap` candidates are kept, in document order; the cut is flagged so no value of this field can be found with certainty.
    return { id: f.id, description: f.description, candidates: m.error !== null ? [] : present.slice(0, cap), truncated: m.truncated || (m.error === null && (present.length > cap || dropped)), tooLong: m.too_long, error: m.error };
  });
}

// Plan §9 cost study: Jev is called only for fields with 2+ candidates; none or one is decided by the regex alone.
const needsJev = (p: Prepared): boolean => p.error === null && p.candidates.length >= 2;

function build(i: ExtractInput, t: Thresholds): Built {
  const prepared = prepare(i, t);
  const total = prepared.reduce((n, p) => n + p.candidates.reduce((m, c) => m + c.length, 0), 0);
  if (total > MAX_TOTAL_CANDIDATE_CHARS) throw new PolicyError(`batch too large: ${total} candidate characters exceed the ${MAX_TOTAL_CANDIDATE_CHARS}-character budget; tighten the patterns or split the call`);
  const ev = evidenceOf(i.document);
  const purpose = i.purpose === undefined ? "" : " Use `shared.purpose` as the reason for the extraction.";
  const units: BuiltUnit[] = prepared.flatMap((p, k) =>
    needsJev(p)
      ? [{
          kind: "atomic" as const,
          // WHY null: the document is shared state; the field name and description are short caller parameters and stay in the instructions (D5).
          state: null,
          questions: {
            [fieldKey(k)]: choice(
              // D5 exception: the candidate values are untrusted document text and sit in criteria because the options ARE the values; the guard covers them.
              `Which candidate is the value of the field ${JSON.stringify(p.id)} (${JSON.stringify(p.description)}) in \`shared.sources[0]\`? Pick the candidate the document presents as this field's value, or ${NONE_OF_THEM} if none is.${purpose} ${dataGuard("the document and the candidate values")}`,
              { ...Object.fromEntries(p.candidates.map((c, j) => [`c${j}`, `Candidate value: ${JSON.stringify(c)}`])), [NONE_OF_THEM]: "None of the candidates is the value this field asks for" },
            ),
          },
        }]
      : [],
  );
  // WHY truncated forwarded: a cut document may hide the true value, so the runner passes it to project, which demotes found to review.
  return { sharedState: { purpose: i.purpose ?? null, sources: (ev.sharedState as { sources: unknown[] }).sources }, units, unsplittable: {}, truncated: ev.ctx.truncated, ...(units.length === 0 ? { noCall: true as const } : {}) }; // WHY noCall (E65): zero units is a design outcome, not a build bug, whatever the cause: every field decided by the regex alone (0 or 1 candidate), an invalid pattern, or every candidate dropped by `prepare` as not verbatim in the cut document (then project reports review, never found or not_found); the runner may skip the model
}

function project(answers: Answers, i: ExtractInput, t: Thresholds, ctx: ProjectCtx): ExtractResult {
  const prepared = prepare(i, t);
  const invalid: ExtractResult["invalid"] = [];
  const rows = prepared.map((p, k): ExtractRow => {
    const base = { id: p.id, value: null, reason: null, confidence: null, top_probability: null, margin: null, candidates_considered: p.candidates.length, candidates_truncated: p.truncated, matches_skipped_too_long: p.tooLong };
    // WHY an incomplete universe poisons every outcome (jev-mcp): the right value may be among the matches that were capped, dropped, skipped or cut with the document, so nothing can be found with certainty and even a confident none_of_them is provisional.
    // WHY separate reasons: a cut or dropped list (candidate_limit) and matches skipped for length (matches_too_long) are fixed by different caller changes.
    const incomplete = p.truncated ? "candidate_limit" : p.tooLong > 0 ? "matches_too_long" : ctx.truncated ? "document_truncated" : null;
    if (p.error !== null) return { ...base, status: "invalid_pattern", reason: p.error };
    // E65: no candidate, no API call; but a cut list, skipped matches or a cut document may hide the value, so only a complete empty list is not_found.
    if (p.candidates.length === 0) return incomplete ? { ...base, status: "review", reason: incomplete } : { ...base, status: "not_found", reason: "no_regex_matches" };
    if (p.candidates.length === 1) return incomplete ? { ...base, status: "review", reason: incomplete, value: p.candidates[0]! } : { ...base, status: "found", reason: "single_match", value: p.candidates[0]! };
    const a = answers[fieldKey(k)];
    const fail = (reason: string): ExtractRow => {
      // WHY the reason is kept: a stopped or lost request must say which fields it left unanswered and why.
      invalid.push({ id: p.id, reason });
      return { ...base, status: "invalid", reason };
    };
    if (!a?.ok) return fail(a?.reason ?? "no answer");
    const c = a.answer as ChoiceAnswer;
    // WHY the shared argmax check (jev-mcp): a chosen option below the top probability is a malformed answer, never a semantic outcome.
    const g = checkedChoice(c, "candidate", spec.validation);
    if ("error" in g) return fail(g.error);
    const scored = { ...base, confidence: c.confidence ?? null, top_probability: g.top, margin: g.top - (g.runnerUp ?? 0) };
    // WHY !c.tie: a tie is a valid answer that must be looked at, even with margin 0.
    const sure = g.top >= t.auto! && !c.tie && marginMet(g.best, g.runnerUp, t.margin!);
    if (c.choice === NONE_OF_THEM) {
      if (incomplete) return { ...scored, status: "review", reason: incomplete };
      // The negative answer is gated like a positive one.
      return sure ? { ...scored, status: "not_found", reason: "none_matched" } : { ...scored, status: "review", reason: "none_matched_ambiguous" };
    }
    const value = p.candidates[Number(c.choice.slice(1))]!;
    if (incomplete) return { ...scored, status: "review", reason: incomplete, value };
    return sure ? { ...scored, status: "found", value } : { ...scored, status: "review", reason: "ambiguous_pick", value };
  });
  const summary: Record<ExtractStatus, number> = { found: 0, not_found: 0, review: 0, invalid_pattern: 0, invalid: 0 };
  for (const r of rows) summary[r.status]++;
  return { fields: rows, summary, document_truncated: ctx.truncated, thresholds: { auto: t.auto!, margin: t.margin!, candidate_cap: t["candidate-cap"]! }, invalid };
}

export const spec: DecisionSpec<ExtractInput, ExtractResult> = {
  id: "extract",
  input: extractInputSchema,
  thresholds: {
    auto: { default: 0.85, min: 0, max: 1, help: "--auto: lowest top probability that makes a pick found" },
    margin: { default: 0.5, min: 0, max: 1, help: "--margin: lowest gap between the top two candidates for a pick to be found" },
    "candidate-cap": { default: 20, min: 2, max: 100, help: "--candidate-cap: most regex matches kept per field; more are cut and the field cannot be found with certainty" },
  },
  // Plan §5: unit = field; a lost request invalidates the fields it carried.
  split: "per-item",
  // Plan §9: field name and description in the instructions; the exception: candidate values in criteria.
  injection: "params-in-instructions",
  validation: DEFAULT_POLICY,
  // WHY only { signal }, never `spawn` (XZZ2NSWY): the worker is made by regex-worker.ts alone; passing the options through would let a caller replace it. The cap is the candidate-cap threshold, the value withMatches range-checks.
  prepare: (i, t, { signal }) => withMatches(i, t["candidate-cap"]!, { signal }),
  build,
  project,
  // Plan §9: not_found, review, invalid_pattern, invalid.
  attention: (r) => r.fields.some((f) => f.status !== "found"),
};
