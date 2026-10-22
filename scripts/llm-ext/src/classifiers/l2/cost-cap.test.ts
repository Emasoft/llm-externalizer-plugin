import { describe, expect, it } from "vitest";
import type { DecisionsModel } from "../l0/catalog.js";
import { resolveModel } from "../l0/model.js";
import { estimateTokens } from "../l1/estimate.js";
import { BUDGET_EXIT_CODE, BudgetTracker, checkEstimate } from "./cost-cap.js";

const model = (promptUsdPerM: number | null): DecisionsModel => ({ id: "typesafe/jev-1.13", canonicalSlug: "typesafe/jev-1.13-20260917", contextTokens: 64000, promptUsdPerM, outputModalities: ["decisions"], systemOne: true });
const resolved = (price: number | null) => resolveModel("typesafe/jev-1.13", [model(price)]);
const tokens = estimateTokens("x".repeat(400_000)); // a large real state: well above 100k tokens

describe("checkEstimate", () => {
  it("D2/E49: without --max-budget no check runs, whatever the estimate or price (even an unknown price)", () => {
    expect(() => checkEstimate({ maxBudgetUsd: undefined, estimatedInputTokens: 1e12, model: resolved(0.042) })).not.toThrow();
    expect(() => checkEstimate({ maxBudgetUsd: undefined, estimatedInputTokens: 1e12, model: resolved(null) })).not.toThrow();
  });
  it("E49: refuses when the estimate exceeds the cap, naming both figures", () => {
    // tokens * 0.042 / 1e6 USD
    const est = (tokens * 0.042) / 1e6;
    expect(() => checkEstimate({ maxBudgetUsd: est / 2, estimatedInputTokens: tokens, model: resolved(0.042) })).toThrow(/exceeds --max-budget/);
  });
  it("accepts an estimate at or below the cap", () => {
    const est = (tokens * 0.042) / 1e6;
    expect(() => checkEstimate({ maxBudgetUsd: est, estimatedInputTokens: tokens, model: resolved(0.042) })).not.toThrow();
  });
  it("E87: refuses before any call when the model price is unknown", () => {
    expect(() => checkEstimate({ maxBudgetUsd: 99.9, estimatedInputTokens: 10, model: resolved(null) })).toThrow(/price/);
  });
  it("rejects a zero, negative or non-finite cap (a cap of 0 lets nothing through; the plan is silent, so it is invalid)", () => {
    for (const bad of [0, -1, NaN, Infinity]) expect(() => checkEstimate({ maxBudgetUsd: bad, estimatedInputTokens: 1, model: resolved(0.042) })).toThrow(/--max-budget/);
  });
});

describe("BudgetTracker", () => {
  it("D2: without a cap it never asks to stop", () => {
    const t = new BudgetTracker(undefined);
    t.add(1e9);
    expect(t.exceeded()).toBe(false);
    expect(t.stopped()).toBeNull();
  });
  it("E86: stops once the running cost passes the cap and reports stopped budget", () => {
    const t = new BudgetTracker(0.01);
    t.add(0.004);
    expect(t.exceeded()).toBe(false);
    t.add(0.007);
    expect(t.exceeded()).toBe(true);
    expect(t.stopped()).toBe("budget");
    expect(t.spent()).toBeCloseTo(0.011, 12);
  });
  it("a cost exactly at the cap has not passed it", () => {
    const t = new BudgetTracker(0.5);
    t.add(0.5);
    expect(t.exceeded()).toBe(false);
  });
  it("add refuses a non-finite or negative cost, so the cap cannot be silently switched off", () => {
    const t = new BudgetTracker(1);
    for (const bad of [NaN, -0.1, Infinity]) expect(() => t.add(bad)).toThrow(/cost/);
    expect(() => new BudgetTracker(0)).toThrow(/--max-budget/);
  });
  it("the estimate error says it is an input cost", () => {
    expect(() => checkEstimate({ maxBudgetUsd: 1e-9, estimatedInputTokens: tokens, model: resolved(0.042) })).toThrow(/estimated input cost/);
  });
  it("E86: a budget stop exits non-zero", () => {
    expect(BUDGET_EXIT_CODE).not.toBe(0);
  });
});
