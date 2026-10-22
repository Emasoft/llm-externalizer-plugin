import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AdaptiveRateLimiter } from "../../rate-limiter.js";
import type { BuiltUnit } from "../catalog/spec.js";
import { parseDecisionsReply } from "../l0/response.js";
import { ClassifierError } from "../l0/errors.js";
import { callDecisions, type GlobalFetch } from "../l0/transport.js";
import { replayFixture, syntheticResponse, type RecordedReply } from "../l0/test-fetch.js";
import type { Question } from "../l1/questions.js";
import { replyCost } from "../l1/usage.js";
import { DEFAULT_POLICY } from "../l1/validate.js";
import { BudgetTracker } from "./cost-cap.js";
import { buildEnvelope } from "./envelope.js";
import { DeadlineError } from "../l0/deadline.js";
import { BilledClassifierError, runPlan, type ExecReply, type RunPlanOptions } from "./fan-out.js";
import { chunkOf, planRequests, type ModelLimits, type Plan } from "./planner.js";

const fixture = (name: string): RecordedReply =>
  JSON.parse(readFileSync(new URL(`../__fixtures__/p01/${name}.json`, import.meta.url), "utf8")) as RecordedReply;

// Real P-01 replies, each answering one question key.
const REPLY_OF: Record<string, string> = { A1: "dec-keyq-ch1", a_b: "dec-keyq-ch2", "a-b": "dec-keyq-ch3", "1": "dec-keyq-ch13" };
const NOUL: Question = { type: "noul", instructions: "Is this a bug?" };
const LIMITS: ModelLimits = { contextTokens: 32000, envelopeTokens: 64, maxRequests: 100, concurrency: 4 };

// One text unit per key: text units travel alone, so each key is its own request.
function planOf(keys: string[]): Plan<BuiltUnit> {
  const plan = planRequests({ sharedState: null, unsplittable: {}, units: keys.map((k) => ({ kind: "text" as const, state: `text of ${k}`, questions: { [k]: NOUL } })) }, LIMITS);
  if (!plan.ok) throw new Error("test plan refused");
  return plan;
}

// The GlobalFetch seam: serves the recorded reply that belongs to the question key in the request body, whatever the call order.
function fetchBy(pick: (key: string) => Response, delayMs = 0, instantKey?: string): { fetch: GlobalFetch; peak: () => number; calls: () => number } {
  let live = 0;
  let peak = 0;
  let calls = 0;
  const fetch: GlobalFetch = async (_url, init) => {
    const key = Object.keys((JSON.parse(String(init.body)) as { questions: object }).questions)[0]!;
    calls++;
    live++;
    peak = Math.max(peak, live);
    try {
      if (delayMs && key !== instantKey) await new Promise((r) => setTimeout(r, delayMs));
      return pick(key);
    } finally {
      live--;
    }
  };
  return { fetch, peak: () => peak, calls: () => calls };
}
const recorded = (key: string): Response => replayFixture(fixture(REPLY_OF[key]!));

function opts(fetchImpl: GlobalFetch, over: Partial<RunPlanOptions<BuiltUnit>> = {}): RunPlanOptions<BuiltUnit> {
  return {
    concurrency: 4,
    timeoutMs: 5000,
    // A fast limiter: the default rps equals the concurrency, which would slow tests down.
    limiter: new AdaptiveRateLimiter(1000),
    split: "per-item",
    policy: DEFAULT_POLICY,
    exec: async (request, deadline): Promise<ExecReply> => {
      const raw = await callDecisions({ endpoint: "decisions", model: "typesafe/jev-1.13", state: request.state, questions: request.questions }, { key: "sk-test", deadline, maxAttempts: 1, fetchImpl });
      return { answers: raw.answers, model: raw.model, usage: raw.usage, cost: replyCost(raw.usage, 0.042) };
    },
    ...over,
  };
}

describe("runPlan", () => {
  it("merges answers by key and sums usage over every request", async () => {
    const keys = ["A1", "a_b", "a-b", "1"];
    const merged = await runPlan(planOf(keys), opts(fetchBy(recorded).fetch));
    expect(Object.keys(merged.answers).sort()).toEqual([...keys].sort());
    for (const k of keys) expect(merged.answers[k]).toMatchObject({ ok: true });
    const env = buildEnvelope({ decision: null, replies: merged.replies, warnings: [], degraded: [], stopped: null });
    const expected = keys.reduce((n, k) => n + (JSON.parse(fixture(REPLY_OF[k]!).body) as { usage: { input_tokens: number } }).usage.input_tokens, 0);
    expect(env.usage.input_tokens).toBe(expected);
    expect(merged.failures).toEqual([]);
  });

  it("never has more requests in flight than the concurrency", async () => {
    const f = fetchBy(recorded, 20);
    await runPlan(planOf(["A1", "a_b", "a-b", "1"]), opts(f.fetch, { concurrency: 2 }));
    expect(f.peak()).toBe(2);
  });

  it("E47 synthetic: a build change mid-run warns and keeps every snapshot", async () => {
    const moved = (key: string): Response => {
      const rec = fixture(REPLY_OF[key]!);
      return replayFixture(key === "a_b" ? { ...rec, body: rec.body.replace("jev-1.13-20260917", "jev-1.13-20260924") } : rec);
    };
    const merged = await runPlan(planOf(["A1", "a_b"]), opts(fetchBy(moved).fetch));
    expect(merged.snapshots).toEqual(["typesafe/jev-1.13-20260917", "typesafe/jev-1.13-20260924"]);
    expect(merged.warnings.map((w) => w.code)).toEqual(["snapshot-changed"]);
    expect(merged.answers["a_b"]).toMatchObject({ ok: true });
  });

  it("a single served build gives no snapshot warning", async () => {
    const merged = await runPlan(planOf(["A1", "a_b"]), opts(fetchBy(recorded).fetch));
    expect(merged.snapshots).toEqual(["typesafe/jev-1.13-20260917"]);
    expect(merged.warnings).toEqual([]);
  });

  it("E48 synthetic: a 429 burst across concurrent requests halves the shared rate once", async () => {
    const limiter = new AdaptiveRateLimiter(8);
    const tooMany = (): Response => syntheticResponse(429, JSON.stringify({ error: { message: "rate limited", code: 429 } }));
    const merged = await runPlan(planOf(["A1", "a_b", "a-b", "1"]), opts(fetchBy(tooMany, 10).fetch, { limiter }));
    expect(merged.failures).toHaveLength(4);
    expect(merged.failures.every((f) => f.error?.class === "rate-limited")).toBe(true);
    expect(limiter.rps).toBe(4);
  });

  it("synthetic: a 429 on a request that started after the halving halves again", async () => {
    const limiter = new AdaptiveRateLimiter(8);
    const tooMany = (): Response => syntheticResponse(429, JSON.stringify({ error: { message: "rate limited", code: 429 } }));
    // concurrency 1: the second request starts after the first one's halving, so it is a new burst.
    await runPlan(planOf(["A1", "a_b"]), opts(fetchBy(tooMany).fetch, { limiter, concurrency: 1 }));
    expect(limiter.rps).toBe(2);
  });

  it("E86: requests not yet sent when the cap is passed are not sent and the run is stopped", async () => {
    const f = fetchBy(recorded);
    // One recorded reply costs 1.2138e-05 USD, so the cap is passed by the second reply.
    const merged = await runPlan(planOf(["A1", "a_b", "a-b", "1"]), opts(f.fetch, { concurrency: 1, budget: new BudgetTracker(1.5e-5) }));
    expect(merged.replies).toHaveLength(2);
    expect(merged.failures.map((x) => x.kind)).toEqual(["budget", "budget"]);
    expect(merged.stopped).toBe("budget");
    expect(merged.warnings.map((w) => w.message)).toEqual([expect.stringContaining("2 of 4 requests not sent")]);
  });

  it("a last request that crosses the cap leaves the run not stopped", async () => {
    const merged = await runPlan(planOf(["A1", "a_b"]), opts(fetchBy(recorded).fetch, { concurrency: 1, budget: new BudgetTracker(1.5e-5) }));
    expect(merged.replies).toHaveLength(2);
    expect(merged.stopped).toBeNull();
  });

  it("a signal aborted before the run sends nothing and reports aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const f = fetchBy(recorded);
    const merged = await runPlan(planOf(["A1", "a_b"]), opts(f.fetch, { signal: ctl.signal }));
    expect(merged.aborted).toBe(true);
    expect(merged.failures.map((x) => x.kind)).toEqual(["aborted", "aborted"]);
    expect(merged.answers["A1"]).toMatchObject({ ok: false, reason: expect.stringMatching(/^aborted: /) });
    expect(merged.replies).toEqual([]);
  });

  it("reports an answer key the request did not ask for, and marks the asked one missing", async () => {
    // The request asks "x"; the recorded reply answers "A1".
    const merged = await runPlan(planOf(["x"]), opts(fetchBy(() => replayFixture(fixture("dec-keyq-ch1"))).fetch));
    expect(merged.answers["x"]).toEqual({ ok: false, reason: "answer missing from reply" });
    expect(merged.warnings).toEqual([{ code: "extra-answer-keys", message: "request 0 answered keys it did not ask for, ignored: A1", count: 1 }]);
    expect(merged.replies).toHaveLength(1);
  });

  it("an error that is not a ClassifierError is the request's failure (bad-response, original as cause), never a rejection of the run", async () => {
    const merged = await runPlan(planOf(["A1"]), opts(fetchBy(recorded).fetch, { exec: () => Promise.reject(new TypeError("bug in exec")) }));
    expect(merged.failures[0]!.error?.cause).toBeInstanceOf(TypeError);
    expect(merged.failures[0]!.message).toMatch(/bug in exec/);
  });

  it("follow-up 1: a DeadlineError timeout from exec keeps class timeout (not an internal error); the name of an unclassified error is in the message and BilledClassifierError keeps the cause", async () => {
    const timed = await runPlan(planOf(["A1"]), opts(fetchBy(recorded).fetch, { exec: () => Promise.reject(new DeadlineError("timeout")) }));
    expect(timed.failures[0]!.error?.class).toBe("timeout");
    expect(timed.failures[0]!.message).not.toMatch(/internal error/);
    const bug = new TypeError("bug in exec");
    const named = await runPlan(planOf(["A1"]), opts(fetchBy(recorded).fetch, { exec: () => Promise.reject(bug) }));
    expect(named.failures[0]!.message).toMatch(/internal error in this request \(TypeError\): bug in exec/);
    expect(new BilledClassifierError(named.failures[0]!.error!, { model: "m", usage: { input_tokens: 1, output_tokens: 1 }, cost: { costUsd: 0 } as never }).cause).toBe(bug);
  });

  // Last pass 1: one path for bills. A reply billed and then lost counts in the replies and in the budget exactly once, whatever the outcome branch.
  describe("a billed-then-lost reply is counted exactly once", () => {
    const billed = { model: "m", usage: { input_tokens: 10, output_tokens: 1 }, cost: { costUsd: 1e-6, cost_estimated: false } } as never;
    const lose = (error: ClassifierError, onThrow?: () => void) => async () => { onThrow?.(); throw new BilledClassifierError(error, billed); };
    const fatal = new ClassifierError({ class: "in-flight-budget", message: "402 in flight", retryable: false });
    const plain = new ClassifierError({ class: "bad-response", message: "bad answers", retryable: false });
    it.each([["fatal", fatal], ["failed", plain]] as const)("billed then %s", async (_n, error) => {
      const budget = new BudgetTracker(1);
      const merged = await runPlan(planOf(["A1"]), opts(fetchBy(recorded).fetch, { budget, exec: lose(error) }));
      expect(merged.replies).toHaveLength(1);
      expect(budget.spent()).toBeCloseTo(1e-6, 12);
    });
    it("billed then aborted (Ctrl-C while the request ran)", async () => {
      const budget = new BudgetTracker(1);
      const ctl = new AbortController();
      const merged = await runPlan(planOf(["A1"]), opts(fetchBy(recorded).fetch, { budget, signal: ctl.signal, exec: lose(plain, () => ctl.abort()) }));
      expect(merged.aborted).toBe(true);
      expect(merged.replies).toHaveLength(1);
      expect(budget.spent()).toBeCloseTo(1e-6, 12);
    });
  });

  // E46: one request of a plan fails, the others succeed.
  describe("partial failure by split class (E46)", () => {
    const keys = ["A1", "a_b", "a-b", "1"];
    // The request for "a_b" fails with a real context-overflow reply (a failure specific to that request); the other three get their recorded replies.
    const oneFails = (key: string): Response => (key === "a_b" ? replayFixture(fixture("dec-err413-12mb")) : recorded(key));

    it("per-item: the failed request's questions become invalid_response, the other answers stand", async () => {
      const merged = await runPlan(planOf(keys), opts(fetchBy(oneFails).fetch, { split: "per-item" }));
      expect(merged.status).toBe("partial");
      expect(merged.answers["a_b"]).toMatchObject({ ok: false, reason: expect.stringContaining("invalid_response: ") });
      for (const k of ["A1", "a-b", "1"]) expect(merged.answers[k]).toMatchObject({ ok: true });
      expect(merged.failures).toHaveLength(1);
      expect(merged.replies).toHaveLength(3);
    });

    it("whole-result: one failed request fails the whole result, usage of the finished replies is kept", async () => {
      const merged = await runPlan(planOf(keys), opts(fetchBy(oneFails).fetch, { split: "whole-result" }));
      expect(merged.status).toBe("failed");
      expect(merged.answers).toEqual({});
      expect(merged.failures).toHaveLength(1);
      expect(merged.replies).toHaveLength(3);
    });

    it("per-item: requests not sent because of --max-budget are invalid_response too", async () => {
      const merged = await runPlan(planOf(keys), opts(fetchBy(recorded).fetch, { concurrency: 1, budget: new BudgetTracker(1.5e-5) }));
      expect(merged.status).toBe("partial");
      expect(merged.answers["a-b"]).toMatchObject({ ok: false, reason: expect.stringContaining("not_sent_budget: ") });
    });

    it("whole-result: requests not sent because of --max-budget fail the whole result", async () => {
      const merged = await runPlan(planOf(keys), opts(fetchBy(recorded).fetch, { concurrency: 1, budget: new BudgetTracker(1.5e-5), split: "whole-result" }));
      expect(merged.status).toBe("failed");
    });

    it("a run with no failed request is complete under both classes", async () => {
      for (const split of ["per-item", "whole-result"] as const) {
        expect((await runPlan(planOf(keys), opts(fetchBy(recorded).fetch, { split }))).status).toBe("complete");
      }
    });

    // The exec of the generic runner reads the reply with parseDecisionsReply, which refuses an unusable body as a bad-response error.
    const parsing = (fetchImpl: GlobalFetch): RunPlanOptions<BuiltUnit>["exec"] => async (request): Promise<ExecReply> => {
      const res = await fetchImpl("https://example.test", { method: "POST", body: JSON.stringify({ questions: request.questions }) });
      const raw = await parseDecisionsReply(res, () => undefined);
      return { answers: raw.answers, model: raw.model, usage: raw.usage, cost: replyCost(raw.usage, 0.042) };
    };
    const nullAnswers = (key: string): Response => {
      const rec = fixture(REPLY_OF[key]!);
      return replayFixture(key === "a_b" ? { ...rec, body: JSON.stringify({ ...(JSON.parse(rec.body) as object), answers: null }) } : rec);
    };

    it("synthetic: a 200 whose answers is null is a failed request, invalid_response for per-item", async () => {
      const f = fetchBy(nullAnswers).fetch;
      const merged = await runPlan(planOf(keys), opts(f, { exec: parsing(f), split: "per-item" }));
      expect(merged.status).toBe("partial");
      expect(merged.failures).toHaveLength(1);
      expect(merged.failures[0]!.error?.class).toBe("bad-response");
      expect(merged.answers["a_b"]).toMatchObject({ ok: false, reason: expect.stringContaining("invalid_response: bad response") });
    });

    it("synthetic: a 200 whose answers is null fails the whole result for whole-result", async () => {
      const f = fetchBy(nullAnswers).fetch;
      const merged = await runPlan(planOf(keys), opts(f, { exec: parsing(f), split: "whole-result" }));
      expect(merged.status).toBe("failed");
      expect(merged.failures[0]!.error?.class).toBe("bad-response");
      // The billed replies of the three good requests still count.
      expect(merged.replies).toHaveLength(3);
    });
  });

  // Owner ruling 2026-10-10: a failure that repeats for every request stops the run at once; one that is specific to a request does not.
  describe("run-wide failures stop the run", () => {
    const keys20 = Array.from({ length: 20 }, (_, i) => `k${i}`);
    const goodReply = (): Response => replayFixture(fixture("dec-keyq-ch1"));

    it("a 401 on request 1 of 20 sends no more than the in-flight requests and reports the auth failure once", async () => {
      const f = fetchBy((key) => (key === "k0" ? replayFixture(fixture("dec-err401")) : goodReply()), 30, "k0");
      const merged = await runPlan(planOf(keys20), opts(f.fetch, { concurrency: 4 }));
      expect(f.calls()).toBeLessThanOrEqual(4);
      expect(merged.status).toBe("failed");
      expect(merged.fatal).toMatchObject({ requestIndex: 0, class: "auth", status: 401 });
      expect(merged.failures.filter((x) => x.kind === "error")).toHaveLength(1);
      expect(merged.failures.filter((x) => x.kind === "fatal")).toHaveLength(20 - f.calls());
      expect(merged.aborted).toBe(false);
      expect(merged.answers["k0"]).toMatchObject({ ok: false, reason: expect.stringMatching(/^invalid_response: /) });
      expect(merged.answers["k7"]).toMatchObject({ ok: false, reason: expect.stringMatching(/^not_sent_fatal: /) });
    });

    it("the same 401 under whole-result gives no answers", async () => {
      const f = fetchBy((key) => (key === "k0" ? replayFixture(fixture("dec-err401")) : goodReply()), 30, "k0");
      const merged = await runPlan(planOf(keys20), opts(f.fetch, { concurrency: 4, split: "whole-result" }));
      expect(merged.status).toBe("failed");
      expect(merged.answers).toEqual({});
    });

    it("synthetic: an in-flight-budget 402 is a credit wall: it stops the run and does not touch the rate limiter", async () => {
      const limiter = new AdaptiveRateLimiter(8);
      const wall = (key: string): Response => (key === "k0" ? syntheticResponse(402, JSON.stringify({ error: { message: "in flight", code: 402, metadata: { limit_source: "openrouter_in_flight_budget" } } })) : goodReply());
      const f = fetchBy(wall, 30, "k0");
      const merged = await runPlan(planOf(keys20), opts(f.fetch, { concurrency: 4, limiter }));
      expect(merged.fatal?.class).toBe("in-flight-budget");
      expect(f.calls()).toBeLessThanOrEqual(4);
      expect(limiter.rps).toBe(8);
    });

    it("a failure specific to one request (context overflow, a recorded real 400) does not stop the others", async () => {
      const merged = await runPlan(planOf(["A1", "a_b", "a-b", "1"]), opts(fetchBy((k) => (k === "a_b" ? replayFixture(fixture("dec-err413-12mb")) : recorded(k))).fetch));
      expect(merged.fatal).toBeNull();
      expect(merged.status).toBe("partial");
      expect(merged.failures[0]!.error?.class).toBe("context-overflow");
      expect(merged.replies).toHaveLength(3);
    });

    it("healthy replies are not delayed: 60 instant replies at concurrency 8 need no limiter wait", async () => {
      const f = fetchBy(goodReply);
      const t0 = Date.now();
      const merged = await runPlan(planOf(Array.from({ length: 60 }, (_, i) => `h${i}`)), { ...opts(f.fetch, { concurrency: 8 }), limiter: undefined });
      expect(merged.failures).toEqual([]);
      expect(f.calls()).toBe(60);
      // The default limiter (8 rps) made this take about 0.9 s.
      expect(Date.now() - t0).toBeLessThan(400);
    });

    it("a bug in exec (not a ClassifierError) is that request's failure with the original as cause; the other requests' replies survive", async () => {
      const base = opts(fetchBy(recorded).fetch);
      const bug = new TypeError("bug in exec");
      const merged = await runPlan(planOf(["A1", "a_b", "a-b", "1"]), { ...base, exec: (r, d) => ("a_b" in r.questions ? Promise.reject(bug) : base.exec(r, d)) });
      expect(merged.status).toBe("partial");
      expect(merged.replies).toHaveLength(3);
      expect(merged.failures).toHaveLength(1);
      expect(merged.failures[0]!.error?.class).toBe("bad-response");
      expect(merged.failures[0]!.error?.cause).toBe(bug);
      expect(merged.failures[0]!.message).toMatch(/bug in exec/);
    });
  });
});


// L2-19: answers of the chunks of one text unit are merged under the unit's own key (plan §5 chunk merge).
describe("runPlan chunk merge", () => {
  const body = Array.from({ length: 60 }, (_, i) => `line ${i + 1} ${"z".repeat(40)}`).join("\n");
  const CHOICE: Question = { type: "choice", instructions: "Which area?", criteria: { cli: "command line", api: "http api", other: "anything else" } };
  const chunked = (q: Question) => {
    const plan = planRequests({ sharedState: null, unsplittable: {}, units: [{ kind: "text" as const, state: body, questions: { t: q } }] }, { ...LIMITS, chunkChars: 1000 });
    if (!plan.ok) throw new Error(plan.message);
    return plan;
  };
  // Serves one synthetic reply per request; `answerOf(n)` is chunk n's answer, a Response replaces the whole reply.
  const serve = (answerOf: (n: number) => unknown | Response): GlobalFetch => async (_url, init) => {
    const key = Object.keys((JSON.parse(String(init.body)) as { questions: object }).questions)[0]!;
    const a = answerOf(Number(/#c(\d+)$/.exec(key)![1]));
    if (a instanceof Response) return a;
    return syntheticResponse(200, JSON.stringify({ model: "typesafe/jev-1.13-20260917", answers: { [key]: a }, usage: { input_tokens: 10, output_tokens: 2, cost: 0.00001 }, provider: "TypeSafe" }));
  };
  const noulAt = (best: number) => (n: number) => ({ type: "noul", noul: n === best ? 0.9 : 0.2 });
  const pick = (label: string, conf: number) => ({ type: "choice", choice: label, probabilities: { cli: label === "cli" ? 0.9 : 0.05, api: 0.05, other: label === "other" ? 0.9 : 0.05 }, confidence: conf });

  it("merges the chunk answers of a unit into one answer under the original key, with chunks, best_chunk and best_lines", async () => {
    const plan = chunked(NOUL);
    const merged = await runPlan(plan, opts(serve(noulAt(3))));
    expect(Object.keys(merged.answers)).toEqual(["t"]);
    expect(merged.answers["t"]).toMatchObject({ ok: true, answer: { type: "noul", noul: 0.9 } });
    const info = chunkOf(plan.requests[2]!.units[0]!)!;
    expect(merged.chunks["t"]).toEqual({ chunks: plan.requests.length, best_chunk: 3, best_lines: [info.from, info.to] });
  });

  it("leaves an unchunked item without a chunks entry", async () => {
    const merged = await runPlan(planOf(["A1"]), opts(fetchBy(recorded).fetch));
    expect(merged.chunks).toEqual({});
  });

  it("choice: a chunk on the default label (last label) does not vote", async () => {
    const merged = await runPlan(chunked(CHOICE), opts(serve((n) => (n === 2 ? pick("cli", 0.3) : pick("other", 0.9)))));
    expect(merged.answers["t"]).toMatchObject({ ok: true, answer: { choice: "cli" } });
    expect(merged.chunks["t"]!.best_chunk).toBe(2);
  });

  it("choice: defaultLabels names another default label", async () => {
    const merged = await runPlan(chunked(CHOICE), opts(serve((n) => (n === 2 ? pick("cli", 0.3) : pick("other", 0.9))), { defaultLabels: { t: "cli" } }));
    expect(merged.answers["t"]).toMatchObject({ ok: true, answer: { choice: "other" } });
  });

  it("an invalid chunk is left out of the merge", async () => {
    const merged = await runPlan(chunked(NOUL), opts(serve((n) => (n === 1 ? { type: "noul", noul: 7 } : noulAt(2)(n)))));
    expect(merged.answers["t"]).toMatchObject({ ok: true, answer: { noul: 0.9 } });
    expect(merged.chunks["t"]!.best_chunk).toBe(2);
  });

  it("every chunk invalid gives an Invalid answer with the first reason and the count", async () => {
    const plan = chunked(NOUL);
    const merged = await runPlan(plan, opts(serve(() => ({ type: "noul", noul: 7 }))));
    expect(merged.answers["t"]).toMatchObject({ ok: false, reason: expect.stringContaining(`all ${plan.requests.length} chunks invalid`) });
    expect(merged.chunks).toEqual({});
  });

  it("per-item: a chunk whose request failed is invalid, the others still merge", async () => {
    const merged = await runPlan(chunked(NOUL), opts(serve((n) => (n === 1 ? syntheticResponse(500, "{}") : noulAt(2)(n)))));
    expect(merged.status).toBe("partial");
    expect(merged.answers["t"]).toMatchObject({ ok: true, answer: { noul: 0.9 } });
  });

  describe("review round: billed failures and the fatal error", () => {
    it("a reply billed and then refused is counted in replies, and the failure stays a ClassifierError", async () => {
      const billed = { model: "m", usage: { input_tokens: 3, output_tokens: 1 }, cost: { costUsd: 0.5, cost_estimated: false } };
      const exec: RunPlanOptions<BuiltUnit>["exec"] = async () => { throw new BilledClassifierError(new ClassifierError({ class: "bad-response", message: "answers is not an object", retryable: false }), billed); };
      const merged = await runPlan(planOf(["A1"]), opts(fetchBy(recorded).fetch, { exec }));
      expect(merged.replies).toEqual([billed]);
      expect(merged.failures[0]!.error).toBeInstanceOf(ClassifierError);
      expect(merged.status).toBe("partial");
    });
    it("the fatal failure carries the original ClassifierError", async () => {
      const merged = await runPlan(planOf(["A1"]), opts(fetchBy(() => replayFixture(fixture("dec-err401"))).fetch));
      expect(merged.fatal?.error).toBeInstanceOf(ClassifierError);
      expect(merged.fatal?.error.class).toBe("auth");
    });
  });
});
