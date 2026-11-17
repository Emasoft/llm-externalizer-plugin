import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noul } from "../l1/questions.js";
import type { GlobalFetch } from "../l0/transport.js";
import { __resetLocalFallbackForTests, answerWithLocalDecider, DECIDER_SINGLETON_PORT, type LocalEscalation } from "./local-fallback.js";
import { planRequests, type ModelLimits, type PlannedRequest, type SplitJob } from "./planner.js";
import { answerWithSplit } from "./split-on-overflow.js";

/**
 * TRDD-1L9VMEY7: answerWithSplit on the REAL planner and the REAL local sender (answerWithLocalDecider, callLocalDecisions, the 422 parse).
 * Only the HTTP reply is faked, at the fetch boundary: a decider that counts state characters / 2 as tokens (so it disagrees with the
 * l1 estimate, as the real one does) and refuses a request over its limit with the measured 422 text.
 */

const SINGLETON = `http://127.0.0.1:${DECIDER_SINGLETON_PORT}`;
const DECIDER_LIMIT = 1500;
// WHY 8000 against a decider limit of 1500: the planner packs by its own estimate, so a whole job lands in ONE request that the decider (chars / 2) then refuses.
const LIMITS: ModelLimits = { contextTokens: 8000, envelopeTokens: 64, maxRequests: 100, concurrency: 1 };
const unit = (i: number, chars: number) => ({ kind: "atomic" as const, state: { text: String(i % 10).repeat(chars) }, questions: { [`q${i}`]: noul(`Is text ${i} about numbers?`) } });
const jobOf = (units: SplitJob["units"]): SplitJob => ({ sharedState: null, units, unsplittable: {} });

interface Posted { keys: string[]; deciderTokens: number }

/** A decider on the singleton port that refuses a state over DECIDER_LIMIT of its own tokens (chars / 2) and answers every question otherwise. */
function fakeDecider(posted: Posted[], status422Text?: (needed: number) => string): GlobalFetch {
  return async (url, init) => {
    if (url === `${SINGLETON}/health`) return new Response(JSON.stringify({ status: "ok", loaded: ["elephant-1"] }), { status: 200 });
    if (url !== `${SINGLETON}/v1/systemone`) throw new Error(`unexpected url ${url}`);
    const body = JSON.parse(String(init.body)) as { state: unknown; questions: Record<string, unknown> };
    const deciderTokens = Math.ceil(JSON.stringify(body.state).length / 2);
    posted.push({ keys: Object.keys(body.questions), deciderTokens });
    if (deciderTokens > DECIDER_LIMIT) {
      const text = status422Text?.(deciderTokens) ?? `the question with its state needs ${deciderTokens} tokens; the limit is ${DECIDER_LIMIT} and input is not cut`;
      return new Response(JSON.stringify({ error: { message: text } }), { status: 422, headers: { "Content-Type": "application/json" } });
    }
    const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { noul: 0.5 }]));
    return new Response(JSON.stringify({ model: "elephant-1", answers, usage: { input_tokens: deciderTokens, output_tokens: 1 } }), { status: 200 });
  };
}

function send(job: SplitJob, request: PlannedRequest, fetchImpl: GlobalFetch): Promise<LocalEscalation> {
  return answerWithSplit({
    job,
    limits: LIMITS,
    request,
    stop: new AbortController().signal,
    ask: (r) => answerWithLocalDecider({
      settings: { local_fallback: {} },
      fetchImpl,
      call: { state: r.state, questions: r.questions },
      decider: { platform: "darwin", discover: async () => [], singletonInstalled: () => true },
    }),
  });
}

const saved = process.env.LLM_EXT_GOVERNOR_ENABLED;
beforeEach(() => {
  // WHY off: the governor lease is a machine-wide resource and this file tests the split, not the lease.
  process.env.LLM_EXT_GOVERNOR_ENABLED = "false";
  __resetLocalFallbackForTests();
});
afterEach(() => {
  if (saved === undefined) delete process.env.LLM_EXT_GOVERNOR_ENABLED;
  else process.env.LLM_EXT_GOVERNOR_ENABLED = saved;
  __resetLocalFallbackForTests();
});

describe("answerWithSplit", () => {
  it("a request the decider refuses with a 422 is split and every question is answered, usage summed, cost 0", async () => {
    const job = jobOf(Array.from({ length: 8 }, (_v, i) => unit(i, 600)));
    const plan = planRequests(job, LIMITS);
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.requests).toHaveLength(1);
    const posted: Posted[] = [];
    const r = await send(job, plan.requests[0]!, fakeDecider(posted));
    if (!r.ok) throw new Error(r.reason);
    expect(Object.keys(r.reply.answers).sort()).toEqual(Object.keys(plan.requests[0]!.questions).sort());
    // the first post was the whole request (refused), then the pieces, each under the decider limit
    expect(posted[0]!.keys).toHaveLength(8);
    expect(posted[0]!.deciderTokens).toBeGreaterThan(DECIDER_LIMIT);
    expect(posted.length).toBeGreaterThan(2);
    expect(posted.slice(1).every((p) => p.deciderTokens <= DECIDER_LIMIT)).toBe(true);
    expect(r.reply.usage.input_tokens).toBe(posted.slice(1).reduce((n, p) => n + p.deciderTokens, 0));
    expect(r.reply.cost).toEqual({ costUsd: 0, cost_estimated: false });
    expect(r.reply.model).toBe("elephant-1");
  });

  it("a unit that alone is over the decider limit fails only its own question: the others keep their answers", async () => {
    const job = jobOf([...[0, 1, 2, 3, 4, 5].map((i) => unit(i, 600)), unit(6, 3600), unit(7, 600)]);
    const plan = planRequests(job, LIMITS);
    if (!plan.ok) throw new Error(plan.message);
    const r = await send(job, plan.requests[0]!, fakeDecider([]));
    if (!r.ok) throw new Error(r.reason);
    const keys = Object.keys(r.reply.answers);
    expect(keys).not.toContain("q6");
    expect(keys.sort()).toEqual(["q0", "q1", "q2", "q3", "q4", "q5", "q7"]);
  });

  it("a partial split carries the failed piece real reason (the decider 422 with its counts) and its question count to the caller", async () => {
    // TRDD-1L9VMEY7: runPlan can only say "answer missing from reply" for the keys of a failed piece, so the reason must ride on the success value.
    const job = jobOf([...[0, 1, 2, 3, 4, 5].map((i) => unit(i, 600)), unit(6, 3600), unit(7, 600)]);
    const plan = planRequests(job, LIMITS);
    if (!plan.ok) throw new Error(plan.message);
    const posted: Posted[] = [];
    const r = await send(job, plan.requests[0]!, fakeDecider(posted));
    if (!r.ok) throw new Error(r.reason);
    expect(r.failedPieces).toHaveLength(1);
    const failed = r.failedPieces![0]!;
    expect(failed.questions).toBe(1);
    // the reason names the decider own counts for the 1-unit piece (the tokens the fake decider counted when that piece was posted), not a generic "no answer"
const pieceTokens = posted.find((p) => p.keys.length === 1 && p.keys[0] === "q6")!.deciderTokens;
    expect(failed.reason).toContain(`needs ${pieceTokens} tokens; the limit is ${DECIDER_LIMIT}`);
    expect(failed.reason).toContain("not retryable");
  });

  it("a split whose pieces all answer carries no failedPieces", async () => {
    const job = jobOf(Array.from({ length: 8 }, (_v, i) => unit(i, 600)));
    const plan = planRequests(job, LIMITS);
    if (!plan.ok) throw new Error(plan.message);
    const r = await send(job, plan.requests[0]!, fakeDecider([]));
    if (!r.ok) throw new Error(r.reason);
    expect(r.failedPieces).toBeUndefined();
  });
  it("when no piece answers, the first failure is the failure: the decider 422 with its counts", async () => {
    const job = jobOf([unit(0, 3600), unit(1, 3600)]);
    const plan = planRequests(job, LIMITS);
    if (!plan.ok) throw new Error(plan.message);
    const posted: Posted[] = [];
    const r = await send(job, plan.requests[0]!, fakeDecider(posted));
    if (r.ok || r.disabled) throw new Error("expected a failure");
    expect(r.error?.status).toBe(422);
// the whole request, then one piece per unit: the failure reported is the first PIECE (1 unit, not splittable), not the whole-request refusal
    expect(posted).toHaveLength(3);
    expect(r.error?.needed_tokens).toBe(posted[1]!.deciderTokens);
    expect(r.error?.limit_tokens).toBe(DECIDER_LIMIT);
  });

  it("a 1-unit request is not split: one post, the original 422", async () => {
    const job = jobOf([unit(0, 3600)]);
    const plan = planRequests(job, LIMITS);
    if (!plan.ok) throw new Error(plan.message);
    const posted: Posted[] = [];
    const r = await send(job, plan.requests[0]!, fakeDecider(posted));
    expect(r.ok).toBe(false);
    expect(posted).toHaveLength(1);
  });

  it("a 422 whose text has no counts is not split", async () => {
    const job = jobOf(Array.from({ length: 8 }, (_v, i) => unit(i, 600)));
    const plan = planRequests(job, LIMITS);
    if (!plan.ok) throw new Error(plan.message);
    const posted: Posted[] = [];
    const r = await send(job, plan.requests[0]!, fakeDecider(posted, () => "state too large"));
    if (r.ok || r.disabled) throw new Error("expected a failure");
    expect(r.error?.needed_tokens).toBeUndefined();
    expect(posted).toHaveLength(1);
  });

  it("an aborted stop signal sends no further piece", async () => {
    const job = jobOf(Array.from({ length: 8 }, (_v, i) => unit(i, 600)));
    const plan = planRequests(job, LIMITS);
    if (!plan.ok) throw new Error(plan.message);
    const posted: Posted[] = [];
    const stop = new AbortController();
    const base = fakeDecider(posted);
    const fetchImpl: GlobalFetch = async (url, init) => {
      const res = await base(url, init);
      if (res.status === 200 && url.endsWith("/v1/systemone")) stop.abort();
      return res;
    };
    const r = await answerWithSplit({
      job,
      limits: LIMITS,
      request: plan.requests[0]!,
      stop: stop.signal,
      ask: (q) => answerWithLocalDecider({ settings: { local_fallback: {} }, fetchImpl, signal: stop.signal, call: { state: q.state, questions: q.questions }, decider: { platform: "darwin", discover: async () => [], singletonInstalled: () => true } }),
    });
    // the first piece answered, then the stop ended the loop: partial answers, no more posts
    if (!r.ok) throw new Error(r.reason);
    expect(Object.keys(r.reply.answers).length).toBeLessThan(8);
    expect(posted.filter((p) => p.deciderTokens <= DECIDER_LIMIT)).toHaveLength(1);
  });
});