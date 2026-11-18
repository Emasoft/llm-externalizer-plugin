// TRDD-1L9VMEY7: the ONE wrapper of every local decider send that has a PlannedRequest (the local-only path and the local escalation of a remote
// profile). WHY it exists: the planner sizes requests by the l1 estimate, which is not the decider tokenizer (measured 2026-11-17: a request
// planned under 16384 was refused as "needs 16460 tokens; the limit is 16384 and input is not cut", and every question of that request became
// "no answer"). A 422 is deterministic, so it is never retried as is; instead the request is split by the decider own counts (replanRequest)
// and the pieces are sent, recursively, until each is answered or holds 1 unit.
import type { BuiltUnit } from "../catalog/spec.js";
import type { Question } from "../l1/questions.js";
import { defaultLabel, mergeChunks, type ChunkAnswer } from "./chunker.js";
import type { LocalEscalation, SplitPieceFailure } from "./local-fallback.js";
import { chunkOf, replanRequest, type ModelLimits, type PlannedRequest, type SplitJob } from "./planner.js";

export interface SplitSendOptions<U extends BuiltUnit> {
  /** The job the request was planned from. */
  job: SplitJob<U>;
  /** The limits the job was planned with, chunkChars included (replanRequest needs the same expanded unit list). */
  limits: ModelLimits;
  request: PlannedRequest<U>;
  /** One send of one request to the local decider; the caller owns serialization, the lease and the usage record. */
  ask: (request: PlannedRequest<U>) => Promise<LocalEscalation>;
  /** Ctrl-C or a command stop: no further piece is sent once it is aborted. */
  stop: AbortSignal;
  /** The explicit default label of each BASE question key, the map runPlan gets (TRDD-NL2012O9: foldPieces must not let a user --default vote). */
  defaultLabels: Record<string, string>;
  /** Internal, set by the recursion on a re-cut: each question key of `request` mapped to its base question key (a piece key carries no chunk info). */
  baseKeys?: Record<string, string>;
}

/**
 * Send `request`; on a decider 422 that names its token counts, split the request and send the pieces. Returns the first failure
 * unchanged when the request cannot be split (1 unit that is not a text chunk, unsplittable questions) or the 422 has no counts. A 1-unit text chunk is cut again
 * from its own text (TRDD-NL2012O9) and its piece answers are folded back under the key of the chunk. WHY partial answers are
 * returned as a success: runPlan validates the merged answers against the ORIGINAL request, so a key whose piece failed is reported as
 * "answer missing from reply" for that key only, and the answers that did arrive are kept; only when no piece answered is the first
 * piece failure the failure of the whole request. Cost is 0 (local), usage is the sum of the pieces. `failedPieces` names each piece that did not answer (its reason and question count) so the caller can say why.
 */
export async function answerWithSplit<U extends BuiltUnit>(opts: SplitSendOptions<U>): Promise<LocalEscalation> {
  const first = await opts.ask(opts.request);
  if (first.ok || first.disabled) return first;
  const e = first.error;
  if (e === undefined || e.status !== 422 || e.needed_tokens === undefined || e.limit_tokens === undefined) return first;
  const plan = replanRequest(opts.job, opts.request, opts.limits, { neededTokens: e.needed_tokens, limitTokens: e.limit_tokens });
  if (!plan.ok) return first;
  // WHY base keys (TRDD-NL2012O9): defaultLabels is keyed by the BASE question key, which is not a string split of a chunk or piece key (a spec key may hold #).
  const baseOf = (key: string): string => opts.baseKeys?.[key] ?? chunkOf(opts.request.units[0]!)?.keys[key] ?? key;
  const recutKeys = plan.recutKeys;
  const pieces: { request: PlannedRequest<U>; result: LocalEscalation }[] = [];
  for (const piece of plan.requests) {
    // WHY the stop check before each piece: a Ctrl-C or command stop must not keep feeding the decider the rest of the pieces.
    if (opts.stop.aborted) break;
    // WHY a re-cut piece gets its own base keys: its keys are new (#rN.i) and its unit has no chunk info, so the lookup would lose the base key one level down.
    const baseKeys = recutKeys === undefined ? opts.baseKeys : Object.fromEntries(Object.keys(piece.questions).map((k) => [k, baseOf(recutKeys[k]!)]));
    pieces.push({ request: piece, result: await answerWithSplit({ ...opts, request: piece, ...(baseKeys === undefined ? {} : { baseKeys }) }) });
  }
  const answered = pieces.map((p) => p.result).filter((p): p is Extract<LocalEscalation, { ok: true }> => p.ok);
  if (answered.length === 0) return pieces.find((p) => !p.result.ok)?.result ?? first;
  const usage = { input_tokens: 0, output_tokens: 0 };
  for (const p of answered) {
    usage.input_tokens += p.reply.usage.input_tokens;
    usage.output_tokens += p.reply.usage.output_tokens;
  }
  const answers: Record<string, unknown> = {};
  // WHY Object.assign is safe: the planner refuses a repeated question key anywhere in the job (E28), so no piece can overwrite another.
  // WHY a fold for a re-cut text chunk (TRDD-NL2012O9): its pieces answer under keys of their own, and the caller expects the keys of the request it sent.
  if (recutKeys === undefined) for (const p of answered) Object.assign(answers, p.reply.answers);
  else Object.assign(answers, foldPieces(opts.request.questions, recutKeys, answered.map((p) => p.reply.answers), (key) => opts.defaultLabels[baseOf(key)]));
  // WHY the failed pieces ride on the success (TRDD-1L9VMEY7): runPlan validates the merged answers against the original request and can only say "answer missing from reply" for a key of a failed piece, so the real reason (the decider 422 with its counts, a deadline) would be lost; the callers print it. A nested split that was itself partial contributes its own failed pieces.
  const failedPieces: SplitPieceFailure[] = pieces.flatMap((p) => (p.result.ok ? (p.result.failedPieces ?? []) : [{ reason: p.result.reason, questions: Object.keys(p.request.questions).length }]));
  const head = answered[0]!;
  return { ok: true, reply: { model: head.reply.model, usage, cost: { costUsd: 0, cost_estimated: false }, answers }, notice: head.notice, ...(failedPieces.length === 0 ? {} : { failedPieces }) };
}

// TRDD-NL2012O9: the number a piece answer is ranked by, read leniently. WHY lenient and no policy: ranking only picks WHICH piece answer stands for the refused chunk; the winner goes back RAW under the refused request key and runPlan validates it there with the spec own policy, so a malformed answer is still refused with its real reason, never hidden. A piece answer that cannot be read does not vote.
function rankable(raw: unknown, q: Question): ChunkAnswer | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const confidence = num(r.confidence);
  const conf = confidence === undefined ? {} : { confidence };
  if (q.type === "noul") {
    const noul = num(r.noul);
    return noul === undefined ? undefined : { type: "noul", noul, ...conf };
  }
  if (q.type === "score") {
    const score = num(r.score);
    return score === undefined ? undefined : { type: "score", score, ...conf };
  }
  return typeof r.choice === "string" && Object.hasOwn(q.criteria, r.choice) ? { type: "choice", choice: r.choice, tie: false, ...conf } : undefined;
}

/**
 * TRDD-NL2012O9: fold the answers of the pieces of one re-cut text chunk (`replies`, in piece order, answered pieces only) back under the question keys of the request the
 * decider refused, as fan-out mergeChunkAnswers folds the chunks of a text unit: the highest noul / score / confidence decides, a choice that names the default label (the last
 * one, as runPlan uses when the user gave no --default) does not vote, ties go to the earliest piece (mergeChunks). A key no answered piece answered is left out, so runPlan reports it as missing.
 * WHY the winner is returned as the raw answer of its piece: runPlan validates the merged answers against the ORIGINAL request keys, so the fold must hand back what the decider said, not a re-typed copy.
 */
function foldPieces(questions: Record<string, Question>, pieceKeys: Record<string, string>, replies: Record<string, unknown>[], defaultOf: (key: string) => string | undefined): Record<string, unknown> {
  const byKey = new Map<string, unknown[]>();
  for (const reply of replies) {
    for (const [pieceKey, raw] of Object.entries(reply)) {
      // WHY ignored: a key the piece request did not ask for is an extra answer, which runPlan ignores and warns about on the whole request.
      if (!Object.hasOwn(pieceKeys, pieceKey)) continue;
      const key = pieceKeys[pieceKey]!;
      byKey.set(key, [...(byKey.get(key) ?? []), raw]);
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, raws] of byKey) {
    const q = questions[key]!;
    const ranked = raws.flatMap((raw) => {
      const answer = rankable(raw, q);
      return answer === undefined ? [] : [{ part: { answer }, raw }];
    });
    // WHY the first raw answer when none can be ranked: runPlan then refuses it with the real validation reason instead of "answer missing from reply".
    if (ranked.length === 0) { out[key] = raws[0]; continue; }
    // WHY the explicit default (TRDD-NL2012O9): without it the last label would not vote and a user --default would, the reverse of what runPlan applies to the same question.
    const best = mergeChunks(ranked.map((x) => x.part), q.type === "choice" ? defaultLabel(Object.keys(q.criteria), defaultOf(key)) : undefined);
    out[key] = ranked[best.best_chunk - 1]!.raw;
  }
  return out;
}