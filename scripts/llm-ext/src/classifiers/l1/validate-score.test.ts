import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_POLICY, SCORE_POLICY, VERIFY_POLICY } from "./validate.js";
import { validateScore } from "./validate-score.js";

const reply = (name: string): unknown => {
  const rec = JSON.parse(readFileSync(fileURLToPath(new URL(`../__fixtures__/p01/${name}.json`, import.meta.url)), "utf8"));
  return JSON.parse(rec.body).answers.urgency;
};
const IP = { ...DEFAULT_POLICY, score: "integer-index" as const };

describe("validateScore on real P-01 replies", () => {
  it.each([3, 5, 10].flatMap((n) => [`dec-score${n}`, `sys-score${n}`].map((f) => [f, n] as const)))("%s is valid under expected-value, default and score presets", (f, n) => {
    for (const p of [DEFAULT_POLICY, SCORE_POLICY]) expect(validateScore(reply(f), n, p).ok).toBe(true);
  });
  it("score10 drifts about 0.1 from the expected value and still passes (a fixed 0.02 would reject it)", () => {
    expect(validateScore(reply("dec-score10"), 10, DEFAULT_POLICY).ok).toBe(true);
  });
});

describe("validateScore faults", () => {
  it("E25: score outside [0, N-1] is invalid", () => {
    for (const s of [-0.01, 2.01, 3, NaN, Infinity, "1", null, undefined]) expect(validateScore({ score: s }, 3, SCORE_POLICY).ok).toBe(false);
    expect(validateScore({ score: 0 }, 3, SCORE_POLICY).ok).toBe(true);
    expect(validateScore({ score: 2 }, 3, SCORE_POLICY).ok).toBe(true);
  });
  it("E25: score far from the sum of i*p_i is invalid", () => {
    const probabilities = { "0": 0, "1": 0, "2": 1 };
    expect(validateScore({ score: 1.5, probabilities }, 3, DEFAULT_POLICY).ok).toBe(false);
    expect(validateScore({ score: 1.97, probabilities }, 3, DEFAULT_POLICY).ok).toBe(true);
    expect(validateScore({ score: 1.96, probabilities }, 3, DEFAULT_POLICY).ok).toBe(false);
  });
  it("probabilities: required policy rejects absence, optional accepts it", () => {
    expect(validateScore({ score: 1 }, 3, DEFAULT_POLICY).ok).toBe(false);
    expect(validateScore({ score: 1 }, 3, SCORE_POLICY)).toEqual({ ok: true, answer: { type: "score", score: 1 } });
  });
  it("malformed probabilities are invalid even when optional", () => {
    for (const probabilities of [[0, 0, 1], { "0": 0, "1": 1 }, { "0": 0, "1": 0, "2": 1.5 }, { "0": 0, "1": 0, "3": 1 }, { "0": 0.5, "1": 0.5, "2": 0.5 }])
      expect(validateScore({ score: 1, probabilities }, 3, SCORE_POLICY).ok).toBe(false);
  });
  it("wrong type invalid, absent type accepted, non-object invalid", () => {
    expect(validateScore({ type: "noul", score: 1 }, 3, SCORE_POLICY).ok).toBe(false);
    expect(validateScore({ score: 1 }, 3, SCORE_POLICY).ok).toBe(true);
    for (const v of [null, 1, [1], "x"]) expect(validateScore(v, 3, SCORE_POLICY).ok).toBe(false);
  });
  it("n below 1 or non-integer is a caller bug and throws", () => {
    expect(() => validateScore({ score: 0 }, 0, SCORE_POLICY)).toThrow();
  });
  it("malformed confidence: reject policy invalid, coerce-null drops it", () => {
    const a = { score: 1, confidence: "high" };
    expect(validateScore(a, 3, { ...VERIFY_POLICY, probabilities: "optional" }).ok).toBe(false);
    expect(validateScore(a, 3, SCORE_POLICY)).toEqual({ ok: true, answer: { type: "score", score: 1 } });
  });
});

describe("integer-index policy", () => {
  it("accepts integers in range, rejects fractions and out of range", () => {
    const p = { ...IP, probabilities: "optional" as const };
    expect(validateScore({ score: 2 }, 3, p).ok).toBe(true);
    expect(validateScore({ score: 1.93 }, 3, p).ok).toBe(false);
    expect(validateScore({ score: 3 }, 3, p).ok).toBe(false);
  });
  it("does not compare the index with the expected value", () => {
    const probabilities = { "0": 0.4, "1": 0, "2": 0.6 };
    expect(validateScore({ score: 2, probabilities }, 3, IP).ok).toBe(true);
    expect(validateScore({ score: 2, probabilities }, 3, DEFAULT_POLICY).ok).toBe(false);
  });
});
