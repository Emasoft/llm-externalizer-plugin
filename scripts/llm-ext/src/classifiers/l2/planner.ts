// L2-01/L2-02/L2-03, plan §5: the central request planner. Greedy packing of units into requests under the model limits; refuses, never truncates.
import { estimateTokens } from "../l1/estimate.js";
import type { Question } from "../l1/questions.js";
import type { Built, BuiltUnit } from "../catalog/spec.js";
import { ClassifierError } from "../l0/errors.js";
import type { ResolvedModel } from "../l0/model.js";
import { assertChunkChars, CHUNK_CHARS_DEFAULT, CHUNK_CHARS_MIN, chunkJsonState, chunkText } from "./chunker.js";

// Plan §5 names the planner input SplitJob; it is the catalog's Built (alias, one shape).
export type SplitJob<U extends BuiltUnit = BuiltUnit> = Omit<Built, "units"> & { units: U[] };

// Plan §5 rules: the model wraps {state, questions} in its own tokens; the planner reserves this many.
export const ENVELOPE_TOKENS = 64;

// Plan §3. L2-03 fills it from the catalog; the planner only reads it.
// envelopeTokens is a number, not the literal 64: L2-03 sets it from ENVELOPE_TOKENS, a test may set another value.
export interface ModelLimits {
  contextTokens: number;
  envelopeTokens: number;
  maxRequests: number;
  concurrency: number;
  maxQuestionsPerRequest?: number;
  // L2-19: --chunk-chars, 1000-90000, default 60000. A chunk that still exceeds contextTokens is refused as unit-too-large, never cut further.
  chunkChars?: number;
}

// Request state wire shape: shared part once, then the unit state parts in input order.
export interface RequestState { shared: unknown; units: unknown[] }

export interface PlannedRequest<U extends BuiltUnit = BuiltUnit> {
  state: RequestState;
  questions: Record<string, Question>;
  // The units of this request (already renumbered when the job has `renumber`), and the index of the first one in the job.
  units: U[];
  offset: number;
  tokens: number;
}

export interface Plan<U extends BuiltUnit = BuiltUnit> { ok: true; requests: PlannedRequest<U>[] }

export type Refusal =
  | { ok: false; kind: "reserved-question-key"; key: string; message: string }
  | { ok: false; kind: "unit-too-large"; unitIndex: number; message: string }
  | { ok: false; kind: "state-entry-too-large"; unitIndex: number; key: string; message: string }
  | { ok: false; kind: "unit-too-many-questions"; unitIndex: number; message: string }
  | { ok: false; kind: "unsplittable-too-large"; message: string }
  | { ok: false; kind: "unsplittable-too-many-questions"; message: string }
  | { ok: false; kind: "request-too-large"; offset: number; message: string }
  | { ok: false; kind: "too-many-requests"; needed: number; maxRequests: number; message: string };

function unitName(index: number, unit: BuiltUnit): string {
  return `unit ${index} (questions: ${Object.keys(unit.questions).join(", ")})`;
}

// Why JSON.stringify first: estimateTokens counts a string as raw text, but the request carries it quoted and escaped.
const tok = (v: unknown): number => estimateTokens(JSON.stringify(v));

// Why +1 per question: the comma between members of the questions object; per-piece ceil sums never undercount the whole.
function questionTokens(questions: Record<string, Question>): number {
  return Object.entries(questions).reduce((n, [k, q]) => n + tok({ [k]: q }) + 1, 0);
}

// Why +1: the comma between unit states.
const unitTokens = (u: BuiltUnit): number => tok(u.state) + questionTokens(u.questions) + 1;

// E28 by construction: Object.assign would silently overwrite a repeated key, so a repeat anywhere in the job is a spec bug and stops the plan.
function assertUniqueKeys(job: SplitJob): void {
  const owner = new Map<string, string>();
  const claim = (key: string, who: string): void => {
    const prior = owner.get(key);
    if (prior !== undefined) throw new Error(`question key "${key}" is used by both ${prior} and ${who}; keys must be unique across the job`);
    owner.set(key, who);
  };
  job.units.forEach((u, i) => { for (const k of Object.keys(u.questions)) claim(k, `unit ${i}`); });
  for (const k of Object.keys(job.unsplittable)) claim(k, "the unsplittable questions");
}

// E45: renumber rewrites per-chunk references; it must hand back the same units with the same question keys, or answers could not be mapped back (E28).
function renumbered<U extends BuiltUnit>(job: SplitJob<U>, units: U[], offset: number): U[] {
  if (!job.renumber) return units;
  const out = job.renumber(units, offset) as U[];
  if (out.length !== units.length) throw new Error(`renumber returned ${out.length} units for ${units.length}; it must keep the units`);
  out.forEach((u, i) => {
    if (Object.keys(u.questions).join("\u0000") !== Object.keys(units[i]!.questions).join("\u0000")) throw new Error(`renumber changed the question keys of unit ${offset + i}; it may only rewrite references`);
  });
  // L2-19: a renumber that builds fresh unit objects would drop the symbol-keyed chunk info; carry it over so the merge can always find it.
  return out.map((u, i) => (chunkOf(u) === undefined && chunkOf(units[i]!) !== undefined ? ({ ...u, [CHUNK_INFO]: chunkOf(units[i]!) } as U) : u));
}

// E45: the answers of a chunk refer to positions inside the chunk; this maps one back to the job-wide index.
export function toGlobalIndex(request: PlannedRequest, localIndex: number): number {
  if (!Number.isInteger(localIndex) || localIndex < 0 || localIndex >= request.units.length) throw new Error(`index ${localIndex} is outside the ${request.units.length} units of this request`);
  return request.offset + localIndex;
}


// L2-19: where a chunk came from. `keys` maps each chunk question key back to the unit's own key; from/to are 1-based lines of a text chunk.
// L2-19: where a chunk came from. `keys` maps each chunk question key back to the unit's own key; from/to are 1-based lines of a text chunk; `entries` lists the original top-level keys (object) or indices (array) a JSON group holds, so an index-scoped reference (`sources[i]`) can be mapped back.
export interface ChunkInfo { source: number; index: number; count: number; from?: number; to?: number; entries?: string[]; keys: Record<string, string> }
const CHUNK_INFO = Symbol("chunk");
// Why a symbol property: BuiltUnit (catalog/spec.ts) has no chunk field; a symbol key is never serialized into the request state.
export const chunkOf = (u: BuiltUnit): ChunkInfo | undefined => (u as BuiltUnit & { [CHUNK_INFO]?: ChunkInfo })[CHUNK_INFO];

// L2-19, plan §5: a text unit larger than chunkChars becomes several text units, one per chunk; each keeps the unit's questions under keys `key#cN` so the job-wide key rule (E28) holds, and the merge maps them back through ChunkInfo.keys.
// Why reserved: chunk question keys are the caller key plus `#cN`; a caller key of that shape could collide with them (ids.ts keys come from indexKey and ID_PATTERN, which both forbid `#`, so only free-form keys such as `ask` can hit this).
const RESERVED_KEY = /#c\d+/;

// L2-19, plan §5: a text unit that does not fit one request alone (or is larger than chunkChars) becomes several text units, one per chunk; each keeps the unit's questions under keys `key#cN` so the job-wide key rule (E28) holds, and the merge maps them back through ChunkInfo.keys.
// Why sizes are searched: chunkChars is characters but the limit is tokens (a CJK char costs a token, shared state and questions eat the budget), so chunkChars is an upper bound and the size is halved, not below CHUNK_CHARS_MIN, until every chunk fits.
function expandTextUnits<U extends BuiltUnit>(job: SplitJob<U>, limits: ModelLimits): { ok: true; job: SplitJob<U> } | Refusal {
  const cap = limits.chunkChars ?? CHUNK_CHARS_DEFAULT;
  assertChunkChars(cap);
  for (const key of [...job.units.flatMap((u) => Object.keys(u.questions)), ...Object.keys(job.unsplittable)]) {
    if (RESERVED_KEY.test(key)) return { ok: false, kind: "reserved-question-key", key, message: `question key "${key}" contains the reserved suffix "#c<digits>" that the planner uses for chunk keys; rename it` };
  }
  const budget = limits.contextTokens - limits.envelopeTokens;
  // Why the same arithmetic as planExpanded: a chunk that passes here must pass its E42 check.
  const base = tok({ state: { shared: job.sharedState, units: [] }, questions: {} });
  const fits = (state: unknown, questions: Record<string, Question>): boolean => base + tok(state) + questionTokens(questions) + 1 <= budget;
  const units: U[] = [];
  for (const [source, unit] of job.units.entries()) {
    const splittable = unit.kind === "text" && unit.state !== null && (typeof unit.state === "string" || typeof unit.state === "object");
    if (!splittable || (fits(unit.state, unit.questions) && JSON.stringify(unit.state).length - (typeof unit.state === "string" ? 2 : 0) <= cap)) { units.push(unit); continue; }
    type Piece = { state: unknown; from?: number; to?: number; entries?: string[] };
    const keyed = (i: number): Record<string, Question> => Object.fromEntries(Object.entries(unit.questions).map(([k, q]) => [`${k}#c${i + 1}`, q]));
    let pieces: Piece[] = [];
    for (let size = cap; ; size = Math.max(CHUNK_CHARS_MIN, Math.floor(size / 2))) {
      if (typeof unit.state === "string") pieces = chunkText(unit.state, size).map((c) => ({ state: c.text, from: c.from, to: c.to }));
      else {
        const g = chunkJsonState(unit.state, size);
        if (!g.ok) return { ok: false, kind: "state-entry-too-large", unitIndex: source, key: g.key, message: `${unitName(source, unit)} has the state entry "${g.key}" of ${g.chars} chars, larger than one chunk (chunk-chars ${size}); it cannot be split` };
        pieces = g.groups.map((state, i) => ({ state, entries: g.entries[i]! }));
      }
      if (pieces.every((p, i) => fits(p.state, keyed(i)))) break;
      if (size === CHUNK_CHARS_MIN) return { ok: false, kind: "unit-too-large", unitIndex: source, message: `${unitName(source, unit)} does not fit one request even in chunks of ${CHUNK_CHARS_MIN} chars with the shared state, against ${limits.contextTokens} tokens` };
    }
    pieces.forEach((p, i) => {
      const keys = Object.fromEntries(Object.keys(unit.questions).map((k) => [`${k}#c${i + 1}`, k]));
      const chunk: ChunkInfo = { source, index: i + 1, count: pieces.length, ...(p.from === undefined ? {} : { from: p.from, to: p.to }), ...(p.entries === undefined ? {} : { entries: p.entries }), keys };
      units.push({ ...unit, state: p.state, questions: keyed(i), [CHUNK_INFO]: chunk } as U);
    });
  }
  return { ok: true, job: { ...job, units } };
}

// L2-19: the public entry; chunking first, then the L2-01..03 packing on the expanded units (offsets and renumber see the expanded list).
export function planRequests<U extends BuiltUnit>(job: SplitJob<U>, limits: ModelLimits): Plan<U> | Refusal {
  const expanded = expandTextUnits(job, limits);
  return "job" in expanded ? planExpanded(expanded.job, limits) : expanded;
}


// L2-03, plan §5 Limits: the profile fields the planner limits read (the classifier profile of config.ts, structurally; l2 must not import config).
export interface LimitsProfile { context_tokens?: number; max_requests_per_call: number; concurrency: number }
export interface LimitsInput {
  resolved: ResolvedModel;
  // From l0/model.ts endpointPromptLimit of the alias TARGET's endpoints reply; absent when the caller has not read it.
  endpointPromptLimit?: number;
  profile: LimitsProfile;
  maxQuestionsPerRequest?: number;
}
export type LimitsRefusal = { ok: false; kind: "no-context-limit"; message: string };

// Why the profile counts only when the catalog reports none (plan §4 table and §8: "only an override when the catalog reports 0/unknown"; E18): the catalog owns the limit, so a profile value never beats a known one.
// Why min with the endpoint limit, also for the override: measured, the catalog says 64000 for jev-1.13 but the endpoint accepts about 32k (P-02), and a request over it is a non-retried HTTP 400. An alias has no limits of its own (E17), so the effective model's apply.
export function modelLimits(input: LimitsInput): ModelLimits | LimitsRefusal {
  const { resolved, profile } = input;
  for (const field of ["max_requests_per_call", "concurrency"] as const) {
    if (!Number.isInteger(profile[field]) || profile[field] < 1) throw new Error(`profile ${field} must be a positive integer, got ${String(profile[field])}`);
  }
  const override = profile.context_tokens;
  if (override !== undefined && (!Number.isInteger(override) || override < 1)) throw new Error(`profile context_tokens must be a positive integer, got ${String(override)}`);
  // Why `|| null`: the catalog loader maps 0 to null, but E18 names 0 itself, so a hand-built model with 0 must behave the same.
  const catalog = resolved.effective.contextTokens || null;
  const source = catalog ?? override;
  if (source === undefined) return { ok: false, kind: "no-context-limit", message: `the catalog reports no context length for ${resolved.effective.id}; set context_tokens in the profile` };
  const contextTokens = input.endpointPromptLimit === undefined ? source : Math.min(source, input.endpointPromptLimit);
  return { contextTokens, envelopeTokens: ENVELOPE_TOKENS, maxRequests: profile.max_requests_per_call, concurrency: profile.concurrency, ...(input.maxQuestionsPerRequest === undefined ? {} : { maxQuestionsPerRequest: input.maxQuestionsPerRequest }) };
}

function planExpanded<U extends BuiltUnit>(job: SplitJob<U>, limits: ModelLimits): Plan<U> | Refusal {
  for (const [name, v] of [["contextTokens", limits.contextTokens], ["maxRequests", limits.maxRequests]] as const) {
    if (!Number.isInteger(v) || v < 1) throw new Error(`${name} must be a positive integer, got ${String(v)}`);
  }
  if (!Number.isInteger(limits.envelopeTokens) || limits.envelopeTokens < 0) throw new Error(`envelopeTokens must be a non-negative integer, got ${String(limits.envelopeTokens)}`);
  if (limits.maxQuestionsPerRequest !== undefined && (!Number.isInteger(limits.maxQuestionsPerRequest) || limits.maxQuestionsPerRequest < 1)) {
    throw new Error(`maxQuestionsPerRequest must be a positive integer, got ${String(limits.maxQuestionsPerRequest)}`);
  }
  job.units.forEach((u, i) => {
    // Why throw: JSON drops an undefined state to null inside the array, so the unit would be sent without its content and counted as nothing.
    if (u.state === undefined) throw new Error(`${unitName(i, u)} state is undefined; give it a JSON value`);
  });
  // Why throw: JSON.stringify drops an undefined value, so the request would go out without `shared` and `base` would be miscounted.
  if (job.sharedState === undefined) throw new Error("sharedState is undefined; give it a JSON value (null for none)");
  assertUniqueKeys(job);
  const unsplittableCount = Object.keys(job.unsplittable).length;
  // Why refuse 0 (wording of l1/request-shape.ts): the API answers 400 without questions, so a job with nothing to ask is a caller bug.
  if (unsplittableCount + job.units.reduce((n, u) => n + Object.keys(u.questions).length, 0) < 1) {
    throw new ClassifierError({ class: "bad-request", message: "the job has no questions, it needs at least 1 question; add at least one question", remedy_hint: "add at least one question", retryable: false });
  }

  // Why limit minus the envelope: the model adds its own wrapper tokens around {state, questions} (plan §5 rules).
  const budget = limits.contextTokens - limits.envelopeTokens;
  const maxQ = limits.maxQuestionsPerRequest ?? Infinity;
  // Why the empty-units estimate: the shared part and the whole {state:{shared,units:[]},questions:{}} frame are sent with every request.
  const base = tok({ state: { shared: job.sharedState, units: [] }, questions: {} });

  const build = (units: U[], offset: number, extra: Record<string, Question>): PlannedRequest<U> | Refusal => {
    const finalUnits = renumbered(job, units, offset);
    const questions: Record<string, Question> = {};
    for (const u of finalUnits) Object.assign(questions, u.questions);
    Object.assign(questions, extra);
    const state = { shared: job.sharedState, units: finalUnits.map((u) => u.state) };
    // Why the real body is measured again: renumber may change text length, and a request over the limit is HTTP 400 max_tokens_exceeded, never retried. Without renumber it cannot fire: the estimate is per-char over the JSON text and every piece sum (ceil per piece, a whole token per comma, braces counted per question) is at least the estimate of the whole body.
    const tokens = tok({ state, questions }) + limits.envelopeTokens;
    if (tokens > limits.contextTokens) return { ok: false, kind: "request-too-large", offset, message: `the request for units from ${offset} is ${tokens} tokens after renumbering, over the limit of ${limits.contextTokens}` };
    return { state, questions, units: finalUnits, offset, tokens };
  };

  // L2-02, E44: an unsplittable question travels with every unit (SplitJob does not say which units it references, so all of them), hence one request or a refusal. This replaces the per-unit E42 check: the aggregate is the check.
  if (unsplittableCount > 0) {
    const qCount = unsplittableCount + job.units.reduce((n, u) => n + Object.keys(u.questions).length, 0);
    const cost = base + job.units.reduce((n, u) => n + unitTokens(u), 0) + questionTokens(job.unsplittable);
    const names = Object.keys(job.unsplittable).join(", ");
    if (cost > budget) return { ok: false, kind: "unsplittable-too-large", message: `the unsplittable questions (${names}) and their ${job.units.length} units need ${cost + limits.envelopeTokens} tokens in one request, over the limit of ${limits.contextTokens}` };
    if (qCount > maxQ) return { ok: false, kind: "unsplittable-too-many-questions", message: `the unsplittable questions (${names}) and their ${job.units.length} units have ${qCount} questions, over the limit of ${String(limits.maxQuestionsPerRequest)} for one request` };
    const only = build(job.units, 0, job.unsplittable);
    return "ok" in only ? only : { ok: true, requests: [only] };
  }

  const requests: PlannedRequest<U>[] = [];
  let cur: U[] = [];
  let curStart = 0;
  let curTokens = base;
  let curQ = 0;

  const close = (): Refusal | undefined => {
    if (cur.length === 0) return undefined;
    const r = build(cur, curStart, {});
    if ("ok" in r) return r;
    requests.push(r);
    cur = [];
    curTokens = base;
    curQ = 0;
    return undefined;
  };

  for (const [i, unit] of job.units.entries()) {
    const qCount = Object.keys(unit.questions).length;
    const cost = unitTokens(unit);
    // E42: a unit that cannot fit even alone is refused by name, never truncated.
    if (base + cost > budget) {
      return { ok: false, kind: "unit-too-large", unitIndex: i, message: `${unitName(i, unit)} does not fit one request alone: ${base + cost + limits.envelopeTokens} tokens with the shared state against ${limits.contextTokens}` };
    }
    // Why its own refusal: a question-count overflow is fixed by removing questions, not by shortening text.
    if (qCount > maxQ) {
      return { ok: false, kind: "unit-too-many-questions", unitIndex: i, message: `${unitName(i, unit)} has ${qCount} questions, over the limit of ${String(limits.maxQuestionsPerRequest)} per request` };
    }
    // Why text units travel alone (plan §5, D31): independent file-mode items are never packed together; atomic units that share a state are packed greedily.
    const alone = unit.kind === "text" || (cur.length > 0 && cur[0]?.kind === "text");
    if (cur.length > 0 && (alone || curTokens + cost > budget || curQ + qCount > maxQ)) {
      const refused = close();
      if (refused) return refused;
    }
    if (cur.length === 0) curStart = i;
    cur.push(unit);
    curTokens += cost;
    curQ += qCount;
  }
  const refused = close();
  if (refused) return refused;

  // E43: refuse with the count the plan needs, before any request is sent.
  if (requests.length > limits.maxRequests) {
    return { ok: false, kind: "too-many-requests", needed: requests.length, maxRequests: limits.maxRequests, message: `the plan needs ${requests.length} requests, over the limit of ${limits.maxRequests}` };
  }
  return { ok: true, requests };
}
