import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { choice, noul } from "../l1/questions.js";
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
// TRDD-NL2012O9: a TEXT unit travels alone in its request (planner D31). TEXT is 3420 chars: about 1700 decider tokens (over DECIDER_LIMIT) and about 1100 by the l1 estimate.
const TEXT = "lorem ipsum dolor ".repeat(190);
const textUnit = (key: string, body: string) => ({ kind: "text" as const, state: body, questions: { [key]: noul("Does the text mention the needle?") } });

interface Posted { keys: string[]; deciderTokens: number; state: string }

/**
 * A decider on the singleton port that refuses a state over its limit (DECIDER_LIMIT unless `opts.limit`) of its own tokens (chars / 2) and answers every question otherwise.
 * `opts.noulOf` makes the answer depend on the state text (default 0.5 for all); `opts.answerOf` gives the raw answer of every question instead; `opts.overhead` adds a fixed token cost per request to the decider count (the numbers in its 422 include it).
 */
function fakeDecider(posted: Posted[], status422Text?: (needed: number) => string, opts: { limit?: number; overhead?: number; noulOf?: (state: string) => number; answerOf?: (state: string) => unknown } = {}): GlobalFetch {
  const limit = opts.limit ?? DECIDER_LIMIT;
  return async (url, init) => {
    if (url === `${SINGLETON}/health`) return new Response(JSON.stringify({ status: "ok", loaded: ["elephant-1"] }), { status: 200 });
    if (url !== `${SINGLETON}/v1/systemone`) throw new Error(`unexpected url ${url}`);
    const body = JSON.parse(String(init.body)) as { state: unknown; questions: Record<string, unknown> };
    const state = JSON.stringify(body.state);
    const deciderTokens = Math.ceil(state.length / 2) + (opts.overhead ?? 0);
    posted.push({ keys: Object.keys(body.questions), deciderTokens, state });
    if (deciderTokens > limit) {
      const text = status422Text?.(deciderTokens) ?? `the question with its state needs ${deciderTokens} tokens; the limit is ${limit} and input is not cut`;
      return new Response(JSON.stringify({ error: { message: text } }), { status: 422, headers: { "Content-Type": "application/json" } });
    }
    const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, opts.answerOf?.(state) ?? { noul: opts.noulOf?.(state) ?? 0.5 }]));
    return new Response(JSON.stringify({ model: "elephant-1", answers, usage: { input_tokens: deciderTokens, output_tokens: 1 } }), { status: 200 });
  };
}

function send(job: SplitJob, request: PlannedRequest, fetchImpl: GlobalFetch, limits: ModelLimits = LIMITS, defaultLabels: Record<string, string> = {}): Promise<LocalEscalation> {
  return answerWithSplit({
    job,
    limits,
    request,
    defaultLabels,
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
      defaultLabels: {},
      stop: stop.signal,
      ask: (q) => answerWithLocalDecider({ settings: { local_fallback: {} }, fetchImpl, signal: stop.signal, call: { state: q.state, questions: q.questions }, decider: { platform: "darwin", discover: async () => [], singletonInstalled: () => true } }),
    });
    // the first piece answered, then the stop ended the loop: partial answers, no more posts
    if (!r.ok) throw new Error(r.reason);
    expect(Object.keys(r.reply.answers).length).toBeLessThan(8);
    expect(posted.filter((p) => p.deciderTokens <= DECIDER_LIMIT)).toHaveLength(1);
  });

  // TRDD-NL2012O9: a text unit travels alone (planner D31), so a refused text chunk is a 1-unit request that could not be cut again and every
  // question of it failed. These tests run the REAL planner, sender and 422 parse; only the HTTP reply is faked, as in the tests above.
  describe("a refused text chunk is cut again (TRDD-NL2012O9)", () => {
    const needle = { noulOf: (state: string): number => (state.includes("NEEDLE") ? 0.9 : 0.1) };

    it("one refused text unit is answered from its re-cut pieces under the original key; the pieces own keys never leak", async () => {
      const job = jobOf([textUnit("q0", `${TEXT}NEEDLE`)]);
      const plan = planRequests(job, LIMITS);
      if (!plan.ok) throw new Error(plan.message);
      expect(plan.requests).toHaveLength(1);
      const posted: Posted[] = [];
      const r = await send(job, plan.requests[0]!, fakeDecider(posted, undefined, needle));
      if (!r.ok) throw new Error(r.reason);
      expect(Object.keys(r.reply.answers)).toEqual(["q0"]);
      // the piece that holds the needle decides (highest noul, as mergeChunks does)
      expect(r.reply.answers.q0).toEqual({ noul: 0.9 });
      // the whole text was posted first and refused, then pieces that each fit the decider
      expect(posted[0]!.deciderTokens).toBeGreaterThan(DECIDER_LIMIT);
      expect(posted.length).toBeGreaterThan(2);
      expect(posted.slice(1).every((p) => p.deciderTokens <= DECIDER_LIMIT)).toBe(true);
      // WHY no reserved key: a piece key shaped key#cN would be refused by the planner on a later re-plan, and it must not equal a key of the job
      for (const p of posted.slice(1)) expect(p.keys.every((k) => k !== "q0" && !/#c\d+/.test(k))).toBe(true);
      // the pieces cover the text: the first starts it, the last ends with the needle
      expect(posted[1]!.state).toContain(TEXT.slice(0, 60));
      expect(posted.at(-1)!.state).toContain("NEEDLE");
      expect(r.reply.usage.input_tokens).toBe(posted.slice(1).reduce((n, p) => n + p.deciderTokens, 0));
      expect(r.reply.cost).toEqual({ costUsd: 0, cost_estimated: false });
      expect(r.failedPieces).toBeUndefined();
    });

    it("a refused chunk of a text unit the planner already chunked is answered under its own chunk key", async () => {
      const limits: ModelLimits = { ...LIMITS, chunkChars: 4000 };
      const job = jobOf([textUnit("q0", `${"lorem ipsum dolor ".repeat(388)}NEEDLE`)]);
      const plan = planRequests(job, limits);
      if (!plan.ok) throw new Error(plan.message);
      expect(plan.requests).toHaveLength(2);
      const last = plan.requests[1]!;
      expect(Object.keys(last.questions)).toEqual(["q0#c2"]);
      const posted: Posted[] = [];
      const r = await send(job, last, fakeDecider(posted, undefined, needle), limits);
      if (!r.ok) throw new Error(r.reason);
      expect(Object.keys(r.reply.answers)).toEqual(["q0#c2"]);
      expect(r.reply.answers["q0#c2"]).toEqual({ noul: 0.9 });
      expect(posted[0]!.deciderTokens).toBeGreaterThan(DECIDER_LIMIT);
      expect(posted.length).toBeGreaterThan(2);
    });

    it("a piece the decider still refuses is cut again, down to pieces it accepts", async () => {
      // WHY a decider that understates its need (800 against a real 857 for a 1713-char piece): the scaled budget then lets the first pieces through, and only the second cut gets under the limit
      const job = jobOf([textUnit("q0", `${TEXT}NEEDLE`)]);
      const plan = planRequests(job, LIMITS);
      if (!plan.ok) throw new Error(plan.message);
      const posted: Posted[] = [];
      const r = await send(job, plan.requests[0]!, fakeDecider(posted, () => "the question with its state needs 800 tokens; the limit is 700 and input is not cut", { ...needle, limit: 700 }));
      if (!r.ok) throw new Error(r.reason);
      expect(r.reply.answers).toEqual({ q0: { noul: 0.9 } });
      expect(posted.filter((p) => p.deciderTokens > 700).length).toBeGreaterThan(1);
      expect(posted.at(-1)!.deciderTokens).toBeLessThanOrEqual(700);
    });

    it("a text of 1000 chars or fewer that the decider refuses cannot be cut: one post, the original 422", async () => {
      const job = jobOf([textUnit("q0", "x".repeat(900))]);
      const plan = planRequests(job, LIMITS);
      if (!plan.ok) throw new Error(plan.message);
      const posted: Posted[] = [];
      const r = await send(job, plan.requests[0]!, fakeDecider(posted, undefined, { limit: 100 }));
      if (r.ok || r.disabled) throw new Error("expected a failure");
      expect(r.error?.status).toBe(422);
      expect(posted).toHaveLength(1);
    });

    it("pieces cut down to the 1000-char floor that the decider still refuses end as its 422, with no endless cutting", async () => {
      const job = jobOf([textUnit("q0", `${TEXT}NEEDLE`)]);
      const plan = planRequests(job, LIMITS);
      if (!plan.ok) throw new Error(plan.message);
      const posted: Posted[] = [];
      // WHY an overhead of 2000: a decider whose count is chars / 2 plus a fixed cost per request, with honest numbers in its 422. The scaled budget then still admits 1000-char pieces by the l1 estimate, but every piece (even the short tail) is over the limit by the decider own count.
      const r = await send(job, plan.requests[0]!, fakeDecider(posted, undefined, { limit: 1500, overhead: 2000 }));
      if (r.ok || r.disabled) throw new Error("expected a failure");
      expect(r.error?.status).toBe(422);
      expect(r.error?.limit_tokens).toBe(1500);
      // the whole text, then pieces; no piece is posted twice and the cutting stops at the floor
      expect(posted.length).toBeGreaterThan(2);
      expect(posted.length).toBeLessThan(30);
      expect(posted.slice(1).every((p) => p.deciderTokens > 1500)).toBe(true);
    });

    // TRDD-NL2012O9: the fold of a re-cut choice chunk honours the default label: it never votes, the other label stands even at a lower confidence.
    describe("a choice answer of a re-cut chunk", () => {
      const q = choice("Is there a needle in the text?", { hit: "a needle is there", none: "no needle" });
      const answerOf = (state: string): unknown => (state.includes("NEEDLE") ? { choice: "hit", confidence: 0.6 } : { choice: "none", confidence: 0.99 });
      const run = async (defaultLabels: Record<string, string>) => {
        const job = jobOf([{ kind: "text" as const, state: `${TEXT}NEEDLE`, questions: { c0: q } }]);
        const plan = planRequests(job, LIMITS);
        if (!plan.ok) throw new Error(plan.message);
        const posted: Posted[] = [];
        const r = await send(job, plan.requests[0]!, fakeDecider(posted, undefined, { answerOf }), LIMITS, defaultLabels);
        if (!r.ok) throw new Error(r.reason);
        expect(posted.length).toBeGreaterThan(2);
        return r.reply.answers;
      };

      it("with no default, the last label does not vote and the other label stands even at a lower confidence", async () => {
        expect(await run({})).toEqual({ c0: { choice: "hit", confidence: 0.6 } });
      });

      it("with a default naming a non-last label, that label does not vote and the last label can win", async () => {
        expect(await run({ c0: "hit" })).toEqual({ c0: { choice: "none", confidence: 0.99 } });
      });
    });

    // TRDD-NL2012O9: the base key of a refused request is looked up through chunk info (a spec key may hold #, so never a string split) and carried down a nested re-cut.
    describe("the default label reaches the fold of a chunked or nested re-cut choice", () => {
      const key = "x#y";
      const q = choice("Is there a needle in the text?", { hit: "a needle is there", none: "no needle" });
      const answerOf = (state: string): unknown => (state.includes("NEEDLE") ? { choice: "hit", confidence: 0.6 } : { choice: "none", confidence: 0.99 });
      // WHY the understating decider (needs 800 against a limit of 700): the first pieces get through the scaled budget and are refused again, so the fold runs one level down too
      const understate = () => "the question with its state needs 800 tokens; the limit is 700 and input is not cut";

      it("a chunk of a chunked text unit whose spec key holds a # folds under the default of its base key", async () => {
        const limits: ModelLimits = { ...LIMITS, chunkChars: 4000 };
        const job = jobOf([{ kind: "text" as const, state: `${"lorem ipsum dolor ".repeat(388)}NEEDLE`, questions: { [key]: q } }]);
        const plan = planRequests(job, limits);
        if (!plan.ok) throw new Error(plan.message);
        const last = plan.requests[1]!;
        expect(Object.keys(last.questions)).toEqual([`${key}#c2`]);
        const ask = async (defaultLabels: Record<string, string>) => {
          const posted: Posted[] = [];
          const r = await send(job, last, fakeDecider(posted, undefined, { answerOf }), limits, defaultLabels);
          if (!r.ok) throw new Error(r.reason);
          expect(posted.length).toBeGreaterThan(2);
          return r.reply.answers;
        };
        expect(await ask({})).toEqual({ [`${key}#c2`]: { choice: "hit", confidence: 0.6 } });
        expect(await ask({ [key]: "hit" })).toEqual({ [`${key}#c2`]: { choice: "none", confidence: 0.99 } });
      });

      it("a piece of a piece (a second re-cut) folds under the default of the base key at both levels", async () => {
        // WHY this layout (measured): the middle piece is cut again into leaves with ALPHA (none 0.9) and with NEEDLE (hit 0.6); the inner fold hands up none 0.9 only if it used the default of the base key, else hit 0.6 and the outer answer drops to none 0.5
        const lorem = "lorem ipsum dolor ";
        const job = jobOf([{ kind: "text" as const, state: `${lorem.repeat(94)}ALPHA ${lorem.repeat(34)}NEEDLE ${lorem.repeat(50)}`, questions: { [key]: q } }]);
        const answerOf2 = (state: string): unknown => (state.includes("NEEDLE") ? { choice: "hit", confidence: 0.6 } : { choice: "none", confidence: state.includes("ALPHA") ? 0.9 : 0.5 });
        const plan = planRequests(job, LIMITS);
        if (!plan.ok) throw new Error(plan.message);
        const ask = async (defaultLabels: Record<string, string>) => {
          const posted: Posted[] = [];
          const r = await send(job, plan.requests[0]!, fakeDecider(posted, understate, { answerOf: answerOf2, limit: 700 }), LIMITS, defaultLabels);
          if (!r.ok) throw new Error(r.reason);
          // proof of the nesting: more than one post was refused as over the limit
          expect(posted.filter((p) => p.deciderTokens > 700).length).toBeGreaterThan(1);
          return r.reply.answers;
        };
        expect(await ask({})).toEqual({ [key]: { choice: "hit", confidence: 0.6 } });
        expect(await ask({ [key]: "hit" })).toEqual({ [key]: { choice: "none", confidence: 0.9 } });
      });
    });
  });
});