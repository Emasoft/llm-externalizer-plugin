import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_POLICY, SCORE_POLICY, VERIFY_POLICY } from "./validate.js";
import { validateChoice } from "./validate-choice.js";

const answers = (n: string): Record<string, unknown> => {
  const rec = JSON.parse(readFileSync(fileURLToPath(new URL(`../__fixtures__/p01/${n}.json`, import.meta.url)), "utf8"));
  return JSON.parse(rec.body).answers;
};
const keys = (n: number) => Array.from({ length: n }, (_, i) => `opt${i}`);
const ans = (choice: string, probabilities?: unknown, extra = {}) => ({ type: "choice", choice, probabilities, ...extra });

describe("real P-01 choice replies", () => {
  it.each([[2], [3], [10], [60]])("dec- and sys- choice%i are valid", (n) => {
    for (const pre of ["dec", "sys"]) {
      const a = answers(`${pre}-choice${n}`).team;
      const r = validateChoice(a, keys(n), DEFAULT_POLICY);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
  });
});

describe("scaled sum (E20, E21)", () => {
  it("E20: 3 options summing 1.01 accepted, 0.97 rejected", () => {
    expect(validateChoice(ans("opt0", { opt0: 0.6, opt1: 0.31, opt2: 0.1 }), keys(3), DEFAULT_POLICY).ok).toBe(true);
    const bad = validateChoice(ans("opt0", { opt0: 0.6, opt1: 0.27, opt2: 0.1 }), keys(3), DEFAULT_POLICY);
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { reason: string }).reason).toMatch(/sum/);
  });
  it("E21: 60 options summing 0.95 accepted (tolerance capped at 0.05), 0.94 rejected", () => {
    const mk = (total: number) => {
      const o: Record<string, number> = { opt0: total - 0.59 };
      for (let i = 1; i < 60; i++) o[`opt${i}`] = 0.01;
      return o;
    };
    expect(validateChoice(ans("opt0", mk(0.95)), keys(60), DEFAULT_POLICY).ok).toBe(true);
    expect(validateChoice(ans("opt0", mk(0.94)), keys(60), DEFAULT_POLICY).ok).toBe(false);
  });
  it("fixed policy is stricter than scaled", () => {
    const o = ans("opt0", { opt0: 0.6, opt1: 0.3125, opt2: 0.1 }); // sum 1.0125: inside scaled 0.015, outside fixed 0.01
    expect(validateChoice(o, keys(3), DEFAULT_POLICY).ok).toBe(true);
    expect(validateChoice(o, keys(3), { ...DEFAULT_POLICY, sum: "fixed" }).ok).toBe(false);
  });
});

describe("tie (E22)", () => {
  it("top two within 0.001 sets tie: true", () => {
    const r = validateChoice(ans("opt0", { opt0: 0.45, opt1: 0.45, opt2: 0.1 }), keys(3), DEFAULT_POLICY);
    expect(r).toMatchObject({ ok: true, answer: { tie: true } });
  });
  it("top two 0.01 apart is not a tie", () => {
    const r = validateChoice(ans("opt0", { opt0: 0.46, opt1: 0.45, opt2: 0.09 }), keys(3), DEFAULT_POLICY);
    expect(r).toMatchObject({ ok: true, answer: { tie: false } });
  });
});

describe("invalid probabilities (E23)", () => {
  it.each([[Number.NaN], [-0.1], [1.2], [Number.POSITIVE_INFINITY], ["0.5"]])("%s is invalid", (bad) => {
    expect(validateChoice(ans("opt0", { opt0: bad, opt1: 0.5 }), keys(2), DEFAULT_POLICY).ok).toBe(false);
  });
});

describe("unknown keys (E24)", () => {
  it("choice naming an unknown key is invalid", () => {
    expect(validateChoice(ans("zzz", { opt0: 0.5, opt1: 0.5 }), keys(2), DEFAULT_POLICY).ok).toBe(false);
  });
  it("probabilities naming an unknown key is invalid", () => {
    expect(validateChoice(ans("opt0", { opt0: 0.5, zzz: 0.5 }), keys(2), DEFAULT_POLICY).ok).toBe(false);
  });
});

describe("every option has a probability", () => {
  it("a distribution over a subset of the options is invalid, naming the missing option", () => {
    const r = validateChoice(ans("opt0", { opt0: 0.6, opt1: 0.4 }), keys(3), DEFAULT_POLICY);
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/no entry for "opt2"/);
  });
});

describe("probabilities policy, type and confidence", () => {
  it("required: missing probabilities invalid; optional: accepted", () => {
    expect(validateChoice(ans("opt0"), keys(2), DEFAULT_POLICY).ok).toBe(false);
    expect(validateChoice(ans("opt0"), keys(2), SCORE_POLICY)).toMatchObject({ ok: true, answer: { tie: false } });
  });
  it("wrong explicit type invalid, absent type accepted", () => {
    expect(validateChoice({ type: "noul", choice: "opt0", probabilities: { opt0: 1 } }, keys(2), DEFAULT_POLICY).ok).toBe(false);
    expect(validateChoice({ choice: "opt0", probabilities: { opt0: 0.6, opt1: 0.4 } }, keys(2), DEFAULT_POLICY).ok).toBe(true);
  });
  it("malformed confidence: coerced away by default, rejected by verify policy", () => {
    const a = ans("opt0", { opt0: 0.6, opt1: 0.4 }, { confidence: 7 });
    expect(validateChoice(a, keys(2), DEFAULT_POLICY)).toMatchObject({ ok: true });
    expect(validateChoice(a, keys(2), VERIFY_POLICY).ok).toBe(false);
  });
  it("non-object answers are invalid", () => {
    for (const a of [null, 3, "x", []]) expect(validateChoice(a, keys(2), DEFAULT_POLICY).ok).toBe(false);
  });
});
