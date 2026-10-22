import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ReplyUsage } from "../l0/response.js";
import { replyCost } from "../l1/usage.js";
import { buildEnvelope, renderEnvelope } from "./envelope.js";

const fixture = (n: string): { body: string } => JSON.parse(readFileSync(new URL(`../__fixtures__/p01/${n}.json`, import.meta.url), "utf-8"));
// One real 200 reply: its served build and its usage as the API reported them.
const real = (n: string): { model: string; usage: ReplyUsage } => JSON.parse(fixture(n).body);
const reply = (n: string) => {
  const r = real(n);
  return { model: r.model, usage: r.usage, cost: replyCost(r.usage, 0.042) };
};

describe("buildEnvelope", () => {
  it("carries schema 1, decision, snapshots, usage, cost, warnings, degraded and stopped for a real reply", () => {
    const r = reply("dec-noul");
    const env = buildEnvelope({ decision: { verdict: "yes" }, replies: [r], warnings: [], degraded: [], stopped: null });
    expect(env).toEqual({
      schema: 1,
      decision: { verdict: "yes" },
      snapshots: [r.model],
      usage: { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens },
      cost: { usd: r.cost.costUsd, cost_estimated: r.cost.cost_estimated },
      warnings: [],
      degraded: [],
      stopped: null,
    });
  });

  it("sums usage and cost over replies and keeps each served build once, in first-seen order (E47)", () => {
    const a = reply("dec-noul");
    const b = { model: "typesafe/jev-1.13-20990101", usage: { input_tokens: 10, output_tokens: 2, cost: 0.5 }, cost: replyCost({ input_tokens: 10, output_tokens: 2, cost: 0.5 }, null) };
    const env = buildEnvelope({ decision: null, replies: [a, a, b], warnings: [], degraded: [], stopped: null });
    expect(env.snapshots).toEqual([a.model, b.model]);
    expect(env.usage.input_tokens).toBe(2 * a.usage.input_tokens + 10);
    expect(env.cost.usd).toBeCloseTo(2 * a.cost.costUsd + 0.5, 12);
  });

  it("cost_estimated is true when any reply lacked usage.cost (D8, E12)", () => {
    const billed = reply("dec-noul");
    const estimated = { model: billed.model, usage: { input_tokens: 100, output_tokens: 1 }, cost: replyCost({ input_tokens: 100, output_tokens: 1 }, 0.042) };
    expect(buildEnvelope({ decision: 0, replies: [{ ...billed, cost: { ...billed.cost, cost_estimated: false } }, estimated], warnings: [], degraded: [], stopped: null }).cost.cost_estimated).toBe(true);
    expect(buildEnvelope({ decision: 0, replies: [{ ...billed, cost: { ...billed.cost, cost_estimated: false } }], warnings: [], degraded: [], stopped: null }).cost.cost_estimated).toBe(false);
  });

  it("stopped is \"budget\" when --max-budget ended the run, and finished results are kept (E86)", () => {
    const env = buildEnvelope({ decision: { done: 1 }, replies: [reply("dec-noul")], warnings: [{ code: "budget", message: "budget reached" }], degraded: [], stopped: "budget" });
    expect(env.stopped).toBe("budget");
    expect(env.decision).toEqual({ done: 1 });
    expect(env.warnings).toEqual([{ code: "budget", message: "budget reached" }]);
  });

  it("an envelope with no replies has zero usage and cost, no snapshots", () => {
    const env = buildEnvelope({ decision: null, replies: [], warnings: [], degraded: [{ where: "w", reason: "r", fallback: "f" }], stopped: null });
    expect(env).toMatchObject({ snapshots: [], usage: { input_tokens: 0, output_tokens: 0 }, cost: { usd: 0, cost_estimated: false }, degraded: [{ where: "w", reason: "r", fallback: "f" }] });
  });
});

describe("renderEnvelope", () => {
  it("is the one JSON text that stdout and the -o report both use (D10)", () => {
    const env = buildEnvelope({ decision: { a: 1 }, replies: [reply("dec-noul")], warnings: [], degraded: [], stopped: null });
    const text = renderEnvelope(env);
    expect(JSON.parse(text)).toEqual(env);
    expect(text.endsWith("\n")).toBe(true);
  });
});
