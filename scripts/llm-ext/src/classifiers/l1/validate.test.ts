import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_POLICY, SCORE_POLICY, VERIFY_POLICY, scoreTolerance, sumTolerance, validateNoul } from "./validate.js";

const answers = (n: string): Record<string, unknown> => {
  const rec = JSON.parse(readFileSync(fileURLToPath(new URL(`../__fixtures__/p01/${n}.json`, import.meta.url)), "utf8"));
  return JSON.parse(rec.body).answers;
};

describe("presets", () => {
  it("default preset equals the plan section 6 defaults", () => {
    expect(DEFAULT_POLICY).toEqual({ sum: "scaled", tie: 0.001, score: "expected-value", confidence: "coerce-null", probabilities: "required", legend: "ignore" });
    expect(VERIFY_POLICY).toEqual({ ...DEFAULT_POLICY, confidence: "reject" });
    expect(SCORE_POLICY).toEqual({ ...DEFAULT_POLICY, probabilities: "optional" });
  });
  it("tolerances follow D6 / P-04", () => {
    expect(sumTolerance(DEFAULT_POLICY, 2)).toBeCloseTo(0.01, 6);
    expect(sumTolerance(DEFAULT_POLICY, 3)).toBeCloseTo(0.015, 6);
    expect(sumTolerance(DEFAULT_POLICY, 60)).toBeCloseTo(0.05, 6);
    expect(sumTolerance({ ...DEFAULT_POLICY, sum: "fixed" }, 60)).toBeCloseTo(0.01, 6);
    expect([3, 5, 10].map(scoreTolerance)).toEqual([0.035, 0.07, 0.245].map((x) => expect.closeTo(x, 9)));
  });
});

describe("validateNoul on real P-01 replies", () => {
  it.each(["dec-noul", "sys-noul"])("%s is valid", (n) => {
    const a = answers(n).is_bug;
    expect(validateNoul(a, DEFAULT_POLICY)).toEqual({ ok: true, answer: { type: "noul", noul: (a as { noul: number }).noul } });
  });
});

describe("validateNoul faults", () => {
  it("E26: null or missing noul is invalid", () => {
    expect(validateNoul({ type: "noul", noul: null }, DEFAULT_POLICY).ok).toBe(false);
    expect(validateNoul({ type: "noul" }, DEFAULT_POLICY).ok).toBe(false);
  });
  it("NaN, negative, above 1 and non-numeric are invalid", () => {
    for (const v of [NaN, -0.1, 1.01, "0.5", Infinity]) expect(validateNoul({ type: "noul", noul: v }, DEFAULT_POLICY).ok).toBe(false);
  });
  it("0 and 1 are valid", () => {
    expect(validateNoul({ noul: 0 }, DEFAULT_POLICY).ok).toBe(true);
    expect(validateNoul({ noul: 1 }, DEFAULT_POLICY).ok).toBe(true);
  });
  it("wrong type invalid, absent type accepted, non-object invalid", () => {
    expect(validateNoul({ type: "choice", noul: 0.5 }, DEFAULT_POLICY).ok).toBe(false);
    expect(validateNoul({ noul: 0.5 }, DEFAULT_POLICY).ok).toBe(true);
    for (const v of [null, 0.5, [0.5], "x"]) expect(validateNoul(v, DEFAULT_POLICY).ok).toBe(false);
  });
  it("malformed confidence: reject policy invalid, coerce-null policy drops it", () => {
    const a = { type: "noul", noul: 0.9, confidence: "high" };
    expect(validateNoul(a, VERIFY_POLICY).ok).toBe(false);
    expect(validateNoul(a, DEFAULT_POLICY)).toEqual({ ok: true, answer: { type: "noul", noul: 0.9 } });
  });
  it("well-formed or null confidence passes under both policies", () => {
    expect(validateNoul({ noul: 0.9, confidence: 0.7 }, VERIFY_POLICY)).toEqual({ ok: true, answer: { type: "noul", noul: 0.9, confidence: 0.7 } });
    expect(validateNoul({ noul: 0.9, confidence: null }, VERIFY_POLICY).ok).toBe(true);
  });
});
