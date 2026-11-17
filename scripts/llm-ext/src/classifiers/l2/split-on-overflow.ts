// TRDD-1L9VMEY7: the ONE wrapper of every local decider send that has a PlannedRequest (the local-only path and the local escalation of a remote
// profile). WHY it exists: the planner sizes requests by the l1 estimate, which is not the decider tokenizer (measured 2026-11-17: a request
// planned under 16384 was refused as "needs 16460 tokens; the limit is 16384 and input is not cut", and every question of that request became
// "no answer"). A 422 is deterministic, so it is never retried as is; instead the request is split by the decider own counts (replanRequest)
// and the pieces are sent, recursively, until each is answered or holds 1 unit.
import type { BuiltUnit } from "../catalog/spec.js";
import type { LocalEscalation } from "./local-fallback.js";
import { replanRequest, type ModelLimits, type PlannedRequest, type SplitJob } from "./planner.js";

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
}

/**
 * Send `request`; on a decider 422 that names its token counts, split the request and send the pieces. Returns the first failure
 * unchanged when the request cannot be split (1 unit, unsplittable questions) or the 422 has no counts. WHY partial answers are
 * returned as a success: runPlan validates the merged answers against the ORIGINAL request, so a key whose piece failed is reported as
 * "answer missing from reply" for that key only, and the answers that did arrive are kept; only when no piece answered is the first
 * piece failure the failure of the whole request. Cost is 0 (local), usage is the sum of the pieces.
 */
export async function answerWithSplit<U extends BuiltUnit>(opts: SplitSendOptions<U>): Promise<LocalEscalation> {
  const first = await opts.ask(opts.request);
  if (first.ok || first.disabled) return first;
  const e = first.error;
  if (e === undefined || e.status !== 422 || e.needed_tokens === undefined || e.limit_tokens === undefined) return first;
  const plan = replanRequest(opts.job, opts.request, opts.limits, { neededTokens: e.needed_tokens, limitTokens: e.limit_tokens });
  if (!plan.ok) return first;
  const pieces: LocalEscalation[] = [];
  for (const piece of plan.requests) {
    // WHY the stop check before each piece: a Ctrl-C or command stop must not keep feeding the decider the rest of the pieces.
    if (opts.stop.aborted) break;
    pieces.push(await answerWithSplit({ ...opts, request: piece }));
  }
  const answered = pieces.filter((p): p is Extract<LocalEscalation, { ok: true }> => p.ok);
  if (answered.length === 0) return pieces.find((p) => !p.ok) ?? first;
  const answers: Record<string, unknown> = {};
  const usage = { input_tokens: 0, output_tokens: 0 };
  for (const p of answered) {
    // WHY Object.assign is safe: the planner refuses a repeated question key anywhere in the job (E28), so no piece can overwrite another.
    Object.assign(answers, p.reply.answers);
    usage.input_tokens += p.reply.usage.input_tokens;
    usage.output_tokens += p.reply.usage.output_tokens;
  }
  const head = answered[0]!;
  return { ok: true, reply: { model: head.reply.model, usage, cost: { costUsd: 0, cost_estimated: false }, answers }, notice: head.notice };
}