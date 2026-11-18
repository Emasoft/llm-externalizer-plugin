// L2-01/L2-02/L2-03, plan §5: the central request planner. Greedy packing of units into requests under the model limits; refuses, never truncates.
import { estimateTokens } from "../l1/estimate.js";
import type { Question } from "../l1/questions.js";
import type { Built, BuiltUnit } from "../catalog/spec.js";
import { ClassifierError } from "../l0/errors.js";
import type { ResolvedModel } from "../l0/model.js";
import { assertChunkChars, CHUNK_CHARS_DEFAULT, CHUNK_CHARS_MAX, CHUNK_CHARS_MIN, chunkJsonState, chunkText } from "./chunker.js";

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

// `recutKeys` is set only by replanRequest for a refused text chunk (TRDD-NL2012O9): each piece question key mapped to the question key of the refused request it answers; the caller folds the piece answers under that key.
export interface Plan<U extends BuiltUnit = BuiltUnit> { ok: true; requests: PlannedRequest<U>[]; recutKeys?: Record<string, string> }

export type Refusal =
  | { ok: false; kind: "reserved-question-key"; key: string; message: string }
  | { ok: false; kind: "unit-too-large"; unitIndex: number; message: string }
  | { ok: false; kind: "state-entry-too-large"; unitIndex: number; key: string; message: string }
  | { ok: false; kind: "unit-too-many-questions"; unitIndex: number; message: string }
  | { ok: false; kind: "unsplittable-too-large"; message: string }
  | { ok: false; kind: "unsplittable-too-many-questions"; message: string }
  | { ok: false; kind: "request-too-large"; offset: number; message: string }
  | { ok: false; kind: "request-unsplittable"; message: string }
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

// Why one definition (TRDD-NL2012O9): a chunk of a text unit, and a piece of a re-cut chunk, must pass the E42 check of planExpanded, so both are measured with this one arithmetic.
function chunkFits(job: SplitJob, budget: number): (state: unknown, questions: Record<string, Question>) => boolean {
  const base = tok({ state: { shared: job.sharedState, units: [] }, questions: {} });
  return (state, questions) => base + tok(state) + questionTokens(questions) + 1 <= budget;
}

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
  const fits = chunkFits(job, budget);
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

// TRDD-1L9VMEY7: a little under the measured ratio, so the pieces of a refused request land under the decider limit and not exactly on it.
const REPLAN_MARGIN = 0.95;

// TRDD-1L9VMEY7: the context a re-plan of `request` may use, from the decider own count in its refusal (the ratio is explained on replanRequest); a refusal when nothing is left after the envelope.
function scaledContext(limits: ModelLimits, request: PlannedRequest, overflow: { neededTokens: number; limitTokens: number }): number | Refusal {
  const contextTokens = Math.min(limits.contextTokens, Math.floor(overflow.limitTokens * (request.tokens / overflow.neededTokens) * REPLAN_MARGIN));
  if (contextTokens <= limits.envelopeTokens) return { ok: false, kind: "request-unsplittable", message: `the scaled budget of ${contextTokens} tokens leaves no room after the ${limits.envelopeTokens} token envelope` };
  return contextTokens;
}

/**
 * TRDD-NL2012O9: a text chunk the decider refused as too large (a 1-unit request, since text units travel alone, D31) is cut AGAIN, from its own text.
 * WHY it exists: the plan cuts a text unit once (expandTextUnits) by the l1 estimate, which is not the decider tokenizer (TRDD-1L9VMEY7), so a chunk planned under the decider window can still be refused, and with nothing left to split its request failed every question of it.
 * WHY the search starts at half the chunk and halves until every piece fits the scaled budget: the same search as expandTextUnits, started below the chunk so every piece is strictly smaller than it. The floor is CHUNK_CHARS_MIN: a chunk already that small, or still refused at that size, is a refusal that keeps the original 422 (fail fast, no loop).
 * WHY the plan carries `recutKeys`: the pieces answer under their own keys and the caller folds them back under the key of the refused request (answerWithSplit), so the planner promise of one answer per question key (E28) still holds. A piece key is the request key with its chunk suffix #cN turned into #rN, then .<piece>: it matches no RESERVED_KEY (which the fan-out and a later plan read) and, checked below, no key of the job.
 * Only a string state is cut (the line chunks of a text file): a JSON state group cannot be re-cut without remapping its index-scoped references, so it stays a refusal.
 */
function recutTextRequest<U extends BuiltUnit>(job: SplitJob<U>, request: PlannedRequest<U>, limits: ModelLimits, contextTokens: number): Plan<U> | Refusal {
  const unit = request.units[0]!;
  const text = unit.state as string;
  if (text.length <= CHUNK_CHARS_MIN) return { ok: false, kind: "request-unsplittable", message: `the text chunk has ${text.length} chars, which cannot be cut below the ${CHUNK_CHARS_MIN} char floor` };
  const pieceKey = (key: string, i: number): string => `${key.replace(/#c(\d+)/g, "#r$1")}.${i + 1}`;
  const keyed = (i: number): Record<string, Question> => Object.fromEntries(Object.entries(unit.questions).map(([k, q]) => [pieceKey(k, i), q]));
  const fits = chunkFits(job, contextTokens - limits.envelopeTokens);
  let pieces: string[];
  for (let size = Math.min(CHUNK_CHARS_MAX, Math.max(CHUNK_CHARS_MIN, Math.floor(text.length / 2))); ; size = Math.max(CHUNK_CHARS_MIN, Math.floor(size / 2))) {
    pieces = chunkText(text, size).map((c) => c.text);
    if (pieces.every((p, i) => fits(p, keyed(i)))) break;
    if (size === CHUNK_CHARS_MIN) return { ok: false, kind: "unit-too-large", unitIndex: request.offset, message: `the text chunk does not fit the scaled budget of ${contextTokens} tokens even in pieces of ${CHUNK_CHARS_MIN} chars` };
  }
  const taken = new Set([...job.units.flatMap((u) => Object.keys(u.questions)), ...Object.keys(job.unsplittable)]);
  const recutKeys: Record<string, string> = {};
  for (let i = 0; i < pieces.length; i++) {
    for (const key of Object.keys(unit.questions)) {
      const k = pieceKey(key, i);
      if (taken.has(k)) return { ok: false, kind: "reserved-question-key", key: k, message: `question key "${k}" of a re-cut text piece is already a question key of the job; rename that question` };
      recutKeys[k] = key;
    }
  }
  // WHY no renumber and a fresh unit: the pieces are single-unit requests whose questions already read units[0] (request.units are renumbered), and a copy of the unit would carry the chunk info of the whole chunk.
  const units = pieces.map((state, i) => ({ kind: unit.kind, state, questions: keyed(i) }) as U);
  const sub = planExpanded({ sharedState: job.sharedState, units, unsplittable: {} }, { ...limits, contextTokens, maxRequests: units.length }, request.offset);
  return sub.ok ? { ok: true, requests: sub.requests, recutKeys } : sub;
}

/**
 * TRDD-1L9VMEY7: re-plan the units of ONE planned request into smaller requests, after the local decider refused it with a 422
 * ("needs 16460 tokens; the limit is 16384", measured 2026-11-17). WHY it exists: the planner sizes by the l1 estimate, which is
 * not the decider tokenizer (on code it overcounts about 40 percent, on base64-like text it undercounts up to 2x), so no fixed margin
 * is safe and a request planned under the limit can still be over it by the decider own count.
 * WHY the budget is limit x (estimated / needed): that ratio is the decider own measure of how many of OUR estimated tokens fit its
 * window for THIS content; REPLAN_MARGIN keeps the pieces off the edge, and it is never above the original context.
 * WHY the units are sliced from the re-expanded job, not taken from request.units: those are already renumbered, and a renumber is
 * given the job-wide index, so it must see the original units at their job-wide offset (planExpanded baseOffset). `limits` must be the
 * limits the job was first planned with (chunkChars included) so the expanded list is the same one request.offset indexes.
 * A request that cannot be split (an unsplittable question travels with every unit, or it holds 1 unit that is not a text chunk, TRDD-NL2012O9) or whose re-plan does not
 * yield at least 2 requests is a refusal: the caller keeps the original 422 as the failure.
 */
export function replanRequest<U extends BuiltUnit>(job: SplitJob<U>, request: PlannedRequest<U>, limits: ModelLimits, overflow: { neededTokens: number; limitTokens: number }): Plan<U> | Refusal {
  if (!(overflow.neededTokens > 0) || !(overflow.limitTokens > 0)) throw new Error(`the overflow counts must be positive, got needed ${overflow.neededTokens} and limit ${overflow.limitTokens}`);
  if (Object.keys(job.unsplittable).length > 0) return { ok: false, kind: "request-unsplittable", message: "the request carries unsplittable questions that travel with every unit, so it cannot be split" };
  // TRDD-NL2012O9: a text unit travels alone (D31), so a refused text chunk is a 1-unit request. It is cut again instead of refused: its own text, never the neighbours (it has none).
  if (request.units.length === 1 && typeof request.units[0]!.state === "string" && request.units[0]!.kind === "text") {
    const cut = scaledContext(limits, request, overflow);
    return typeof cut === "number" ? recutTextRequest(job, request, limits, cut) : cut;
  }
  if (request.units.length < 2) return { ok: false, kind: "request-unsplittable", message: "the request holds 1 unit, which cannot be split" };
  const expanded = expandTextUnits(job, limits);
  if (!("job" in expanded)) return expanded;
  const slice = expanded.job.units.slice(request.offset, request.offset + request.units.length);
  if (slice.length !== request.units.length) throw new Error(`request.offset ${request.offset} with ${request.units.length} units is outside the ${expanded.job.units.length} expanded units; limits must be the ones the job was planned with`);
  const contextTokens = scaledContext(limits, request, overflow);
  if (typeof contextTokens !== "number") return contextTokens;
  const scaled: ModelLimits = { ...limits, contextTokens, maxRequests: slice.length };
  // WHY recursive: under the scaled budget a unit may not fit even alone (the decider counted it far above our estimate). That unit must not
  // sink the re-plan of its neighbours, so it goes alone in its own request, planned under the ORIGINAL limits where it already fitted (the
  // decider then refuses it alone and only its own questions end as no answer), and the units before and after it are re-planned the same way.
  const planSlice = (units: U[], base: number): PlannedRequest<U>[] | Refusal => {
    if (units.length === 0) return [];
    const sub = planExpanded({ ...expanded.job, units }, scaled, base);
    if (sub.ok) return sub.requests;
    if (sub.kind !== "unit-too-large") return sub;
    const i = sub.unitIndex;
    const before = planSlice(units.slice(0, i), base);
    if ("ok" in before) return before;
    const own = planExpanded({ ...expanded.job, units: [units[i]!] }, { ...limits, maxRequests: 1 }, base + i);
    if (!own.ok) return own;
    const after = planSlice(units.slice(i + 1), base + i + 1);
    if ("ok" in after) return after;
    return [...before, ...own.requests, ...after];
  };
  const requests = planSlice(slice, request.offset);
  if ("ok" in requests) return requests;
  if (requests.length < 2) return { ok: false, kind: "request-unsplittable", message: "the re-plan did not split the request into smaller ones" };
  return { ok: true, requests };
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

// TRDD-1L9VMEY7: `baseOffset` is the index of job.units[0] in the EXPANDED list of the whole job (0 for a whole-job plan). WHY: renumber and PlannedRequest.offset are job-wide indices; a re-plan of the units of ONE request (replanRequest) plans a slice, and without the base its renumber would restart at 0 and point at the wrong units.
function planExpanded<U extends BuiltUnit>(job: SplitJob<U>, limits: ModelLimits, baseOffset = 0): Plan<U> | Refusal {
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
    const finalUnits = renumbered(job, units, baseOffset + offset);
    const questions: Record<string, Question> = {};
    for (const u of finalUnits) Object.assign(questions, u.questions);
    Object.assign(questions, extra);
    const state = { shared: job.sharedState, units: finalUnits.map((u) => u.state) };
    // Why the real body is measured again: renumber may change text length, and a request over the limit is HTTP 400 max_tokens_exceeded, never retried. Without renumber it cannot fire: the estimate is per-char over the JSON text and every piece sum (ceil per piece, a whole token per comma, braces counted per question) is at least the estimate of the whole body.
    const tokens = tok({ state, questions }) + limits.envelopeTokens;
    if (tokens > limits.contextTokens) return { ok: false, kind: "request-too-large", offset: baseOffset + offset, message: `the request for units from ${baseOffset + offset} is ${tokens} tokens after renumbering, over the limit of ${limits.contextTokens}` };
    return { state, questions, units: finalUnits, offset: baseOffset + offset, tokens };
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
