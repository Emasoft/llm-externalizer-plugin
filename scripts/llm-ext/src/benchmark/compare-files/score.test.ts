// compare_files scorer (TRDD-2G6D42LK). Pure set math — no network, no model.

import { describe, it, expect } from "vitest";

import {
  DEFAULT_COMPARE_FILES_THRESHOLDS,
  hallucinatedSymbols,
  mentions,
  passesThresholds,
  scoreAll,
  scoreDiff,
} from "./score.js";

const CHANGED = ["scoreFile", "buildCheckImportsExtractMessages", "TRUTH"];

describe("compare-files scorer — mentioning a symbol", () => {
  it("matches on WORD BOUNDARIES, not substrings", () => {
    // The load-bearing case: a substring test would credit "score" for
    // "scoreFile", inflating recall — the one metric that gates here.
    expect(mentions("we changed score handling", "scoreFile")).toBe(false);
    expect(mentions("we changed scoreFile", "scoreFile")).toBe(true);
  });

  it("accepts a symbol in prose punctuation", () => {
    expect(mentions("renamed `scoreFile`, then moved it.", "scoreFile")).toBe(true);
    expect(mentions("(scoreFile)", "scoreFile")).toBe(true);
  });

  it("is case-SENSITIVE — identifiers are", () => {
    expect(mentions("the truth set grew", "TRUTH")).toBe(false);
    expect(mentions("TRUTH grew", "TRUTH")).toBe(true);
  });

  it("does not treat an underscore or $ neighbour as a boundary", () => {
    expect(mentions("my_scoreFile_helper changed", "scoreFile")).toBe(false);
  });
});

describe("compare-files scorer — the confusion matrix", () => {
  it("a summary naming every changed symbol scores perfect recall", () => {
    const c = scoreDiff("x", CHANGED, CHANGED.join(", "));
    expect(c.recall).toBe(1);
    expect(c.falseNegatives).toBe(0);
  });

  it("an OMITTED symbol is a false negative", () => {
    const c = scoreDiff("x", CHANGED, "scoreFile and TRUTH changed");
    expect(c.falseNegatives).toBe(1);
    expect(c.recall).toBeCloseTo(2 / 3);
  });

  it("an unusable summary is not scored as an empty one", () => {
    const unparseable = scoreDiff("x", CHANGED, null);
    const empty = scoreDiff("x", CHANGED, "");
    expect(unparseable.unscored).toBeGreaterThan(0);
    expect(empty.unscored).toBe(0);
  });

  it("TRUE NEGATIVES ARE ALWAYS ZERO — pinned so nobody reads meaning into it", () => {
    expect(scoreDiff("x", CHANGED, CHANGED.join(" ")).trueNegatives).toBe(0);
  });
});

describe("compare-files scorer — abstraction is not punished", () => {
  it("PASSES a summary that also discusses things outside the truth set", () => {
    // "renamed the three backfill helpers" is GOOD writing, not a defect. This
    // test fails the moment someone reinstates a precision floor.
    const cases = [
      scoreDiff("a", CHANGED, `${CHANGED.join(", ")} — plus wider cleanup of the ledger path`),
      scoreDiff("b", CHANGED, CHANGED.join(" and ")),
    ];
    expect(passesThresholds(scoreAll(cases)).pass).toBe(true);
  });

  it("REPORTS hallucinated symbols without gating on them", () => {
    const pool = [...CHANGED, "neverChanged"];
    expect(hallucinatedSymbols("we touched neverChanged", CHANGED, pool)).toEqual([
      "neverChanged",
    ]);
  });

  it("does not gate on precision, and asks less recall than check_imports", () => {
    // Summarising abstracts; extraction does not. Demanding 0.95 here would push
    // models toward identifier lists, the opposite of the command's purpose.
    expect(DEFAULT_COMPARE_FILES_THRESHOLDS.minMicroF1).toBe(0);
    expect(DEFAULT_COMPARE_FILES_THRESHOLDS.minMicroRecall).toBe(0.7);
  });

  it("FAILS a summary that names almost nothing", () => {
    const cases = [scoreDiff("a", CHANGED, "changed some stuff"), scoreDiff("b", CHANGED, "misc")];
    expect(passesThresholds(scoreAll(cases)).pass).toBe(false);
  });
});
