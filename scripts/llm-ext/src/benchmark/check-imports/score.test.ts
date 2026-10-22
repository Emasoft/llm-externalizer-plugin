// check_imports scorer (TRDD-f45eeaa0). Pure set math — no network, no model.

import { describe, it, expect } from "vitest";

import {
  DEFAULT_CHECK_IMPORTS_THRESHOLDS,
  passesThresholds,
  scoreAll,
  scoreFile,
} from "./score.js";

const TRUTH = ["node:fs", "./a.js", "../b.js"];

describe("check-imports scorer — the confusion matrix", () => {
  it("a perfect extraction is 1.0 across the board", () => {
    const c = scoreFile("f.ts", TRUTH, [...TRUTH]);
    expect(c.truePositives).toBe(3);
    expect(c.falsePositives).toBe(0);
    expect(c.falseNegatives).toBe(0);
    expect(c.f1).toBe(1);
  });

  it("a MISSED specifier is a false negative, not a silent pass", () => {
    const c = scoreFile("f.ts", TRUTH, ["node:fs", "./a.js"]);
    expect(c.falseNegatives).toBe(1);
    expect(c.recall).toBeCloseTo(2 / 3);
    expect(c.precision).toBe(1);
  });

  it("an INVENTED specifier is a false positive", () => {
    const c = scoreFile("f.ts", TRUTH, [...TRUTH, "./ghost.js"]);
    expect(c.falsePositives).toBe(1);
    expect(c.recall).toBe(1);
    expect(c.precision).toBeCloseTo(3 / 4);
  });

  it("order does not matter — a SET is the unit of truth", () => {
    const c = scoreFile("f.ts", TRUTH, ["../b.js", "node:fs", "./a.js"]);
    expect(c.f1).toBe(1);
  });

  it("duplicates in the model's answer do not inflate the score", () => {
    const c = scoreFile("f.ts", TRUTH, ["node:fs", "node:fs", "./a.js", "../b.js"]);
    expect(c.truePositives).toBe(3);
    expect(c.f1).toBe(1);
  });

  it("TRUE NEGATIVES ARE ALWAYS ZERO, by construction and on purpose", () => {
    // Documented in score.ts: an item enters the universe only if it is true or
    // was reported, so there is no finite population of correct non-reports.
    // Pinned so nobody later reads meaning into the zero — or 'fixes' it.
    expect(scoreFile("f.ts", TRUTH, [...TRUTH]).trueNegatives).toBe(0);
    expect(scoreFile("f.ts", TRUTH, ["./ghost.js"]).trueNegatives).toBe(0);
  });
});

describe("check-imports scorer — an unusable answer", () => {
  it("an unparseable report loses every true specifier, and is not scored as perfect", () => {
    const c = scoreFile("f.ts", TRUTH, null);
    expect(c.truePositives).toBe(0);
    expect(c.f1).toBeLessThan(1);
  });

  it("an EMPTY answer is not the same as an unparseable one", () => {
    // Both are bad, but "I read it and found none" is a claim; "I produced
    // nothing" is a failure to answer. Keeping them distinct is what lets
    // coverage separate a broken model from an inaccurate one.
    const empty = scoreFile("f.ts", TRUTH, []);
    const unparseable = scoreFile("f.ts", TRUTH, null);
    expect(empty.unscored).toBe(0);
    expect(unparseable.unscored).toBeGreaterThan(0);
  });
});

describe("check-imports scorer — the pass bar", () => {
  it("does NOT gate on precision — the tool asks for more than this oracle knows", () => {
    // index.ts's phase-1 prompt asks for "file path strings, configuration
    // references" too. Gating on F1 would fail a model for obeying it.
    expect(DEFAULT_CHECK_IMPORTS_THRESHOLDS.minMicroF1).toBe(0);
    expect(DEFAULT_CHECK_IMPORTS_THRESHOLDS.minMicroRecall).toBeGreaterThanOrEqual(0.95);
  });

  it("PASSES a model that returns extra paths but every declared import", () => {
    // The behaviour the tool actually asks for. This test is the whole reason
    // precision is ungated: it FAILS the moment someone reinstates an F1 floor.
    const cases = [
      scoreFile("a.ts", TRUTH, [...TRUTH, "./config.json", "some/config/ref"]),
      scoreFile("b.ts", TRUTH, [...TRUTH, "./other.json"]),
    ];
    const verdict = passesThresholds(scoreAll(cases));
    expect(verdict.pass).toBe(true);
  });

  it("passes a near-perfect run", () => {
    const cases = [scoreFile("a.ts", TRUTH, [...TRUTH]), scoreFile("b.ts", TRUTH, [...TRUTH])];
    expect(passesThresholds(scoreAll(cases)).pass).toBe(true);
  });

  it("FAILS a run that misses specifiers, and says which floor it missed", () => {
    const cases = [scoreFile("a.ts", TRUTH, ["node:fs"]), scoreFile("b.ts", TRUTH, ["node:fs"])];
    const verdict = passesThresholds(scoreAll(cases));
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.length).toBeGreaterThan(0);
  });
});
