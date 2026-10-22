// Test support for the spec tests: drives a spec through the REAL planner and fan-out (runPlan) against a fake transport, so
// project() is exercised on exactly the answer sets the runner produces when requests fail, the run is stopped or aborted.
import { readFileSync } from "node:fs";
import { AdaptiveRateLimiter } from "../../rate-limiter.js";
import { callDecisions, type GlobalFetch } from "../l0/transport.js";
import { replayFixture, syntheticResponse, type RecordedReply } from "../l0/test-fetch.js";
import { replyCost } from "../l1/usage.js";
import { BudgetTracker } from "../l2/cost-cap.js";
import { runPlan, type ExecReply, type MergedReply } from "../l2/fan-out.js";
import { planRequests, type ModelLimits } from "../l2/planner.js";
import { resolveThresholds } from "../l2/policy-kit.js";
import type { AnySpec } from "./spec.js";

// "abort": Ctrl-C while request failAt is in flight, so its fetch rejects like a real one. "abort-after-reply": Ctrl-C after request failAt answered, so that reply is kept (l2/abort.ts:67-68).
export type Scenario = "one-failed" | "fatal-first" | "budget" | "abort" | "abort-after-reply";

const LIMITS: ModelLimits = { contextTokens: 32000, envelopeTokens: 64, maxRequests: 100, concurrency: 1 };

const fixture = (name: string): RecordedReply => JSON.parse(readFileSync(new URL(`../__fixtures__/p01/${name}.json`, import.meta.url), "utf8")) as RecordedReply;

// A valid answer for any question type the specs ask: the first option wins with 0.9, the rest share 0.1.
function answerFor(q: { type: string; criteria?: unknown }): unknown {
  if (q.type === "noul") return { type: "noul", noul: 0.9 };
  if (q.type === "score") return { type: "score", score: 3, confidence: 0.9 };
  const labels = Object.keys(q.criteria as object);
  return { type: "choice", choice: labels[0], probabilities: Object.fromEntries(labels.map((l, k) => [l, k === 0 ? 0.9 : 0.1 / (labels.length - 1)])), confidence: 0.9 };
}

/** Runs `raw` through `spec` with one request per call (concurrency 1) and returns the fan-out's result and the spec's projection. */
export async function runUnder(spec: AnySpec, raw: unknown, scenario: Scenario, opts: { failAt?: number; limits?: Partial<ModelLimits> } = {}): Promise<{ merged: MergedReply; result: unknown; requests: number; keys: string[][] }> {
  // opts.failAt: the request (0-based call) that fails or aborts; a plan with ONE request (unsplittable or whole-result spec) needs 0.
  // opts.limits: e.g. maxQuestionsPerRequest 1 makes the planner send atomic units one per request instead of packing them into one.
  const failAt = opts.failAt ?? 1;
  const input = spec.input.parse(raw);
  const t = resolveThresholds(spec.thresholds, {});
  const plan = planRequests(spec.build(input, t), { ...LIMITS, ...opts.limits });
  if (!plan.ok) throw new Error(plan.message);
  const ctl = new AbortController();
  let call = 0;
  let execCalls = 0;
  const fetchImpl: GlobalFetch = async (_url, init) => {
    const n = call++;
    const questions = (JSON.parse(String(init.body)) as { questions: Record<string, { type: string; criteria?: unknown }> }).questions;
    if (scenario === "one-failed" && n === failAt) return syntheticResponse(500, "{}");
    if (scenario === "fatal-first" && n === 0) return replayFixture(fixture("dec-err401"));
    if (scenario === "abort" && n === failAt) {
      ctl.abort();
      // WHY reject: a real fetch given an aborted signal rejects with an AbortError and never returns a 200 (the fan-out then records the request as aborted, l2/abort.ts:72).
      throw new DOMException("This operation was aborted", "AbortError");
    }
    const answers = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, answerFor(q)]));
    return syntheticResponse(200, JSON.stringify({ model: "typesafe/jev-1.13-20260917", answers, usage: { input_tokens: 10, output_tokens: 2, cost: 0.00001 }, provider: "TypeSafe" }));
  };
  const merged = await runPlan(plan, {
    concurrency: 1,
    timeoutMs: 5000,
    limiter: new AdaptiveRateLimiter(1000),
    split: spec.split,
    policy: spec.validation,
    signal: ctl.signal,
    ...(scenario === "budget" ? { budget: new BudgetTracker(1.5e-5) } : {}),
    exec: async (request, deadline): Promise<ExecReply> => {
      const execIndex = execCalls++;
      const r = await callDecisions({ endpoint: "decisions", model: "typesafe/jev-1.13", state: request.state, questions: request.questions }, { key: "sk-test", deadline, maxAttempts: 1, fetchImpl });
      // WHY after the reply: Ctrl-C that arrives once the response is in must not discard it (l2/abort.ts:67-68).
      if (scenario === "abort-after-reply" && execIndex === failAt) ctl.abort();
      return { answers: r.answers, model: r.model, usage: r.usage, cost: replyCost(r.usage, 0.042) };
    },
  });
  return { merged, result: spec.project(merged.answers, input, t, { truncated: false }), requests: plan.requests.length, keys: plan.requests.map((q) => Object.keys(q.questions)) };
}
