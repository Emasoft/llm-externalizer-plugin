/**
 * Unit tests for the benchmark scorer (scoreRun).
 *
 * scoreRun is pure scoring math: it compares a model's three returned
 * function-name arrays (run.kw1/kw2/kw3) against the three expected sets
 * (truth.keywordFunctions[0..2]) and computes per-keyword precision /
 * recall / F1 / exactMatch, plus the overall pass flag, mean F1, and the
 * sorted hallucinated set (returned names absent from truth.allFunctions).
 * No network, no I/O — every test builds realistic in-memory RunResult and
 * GroundTruth objects and asserts the EXACT numbers scoreRun computes.
 * Nothing in the unit under test is mocked; the private scoreSet helper is
 * exercised transitively.
 *
 * Coverage focus: a perfect-match run (max score, pass), a partial-match
 * run (precision/recall/F1 math), a zero/no-match run, the empty-result
 * boundary (precision-when-nothing-returned quirk), all-correct and
 * all-wrong boundaries, hallucination detection + dedupe + sort, and the
 * meanF1 averaging across the three buckets.
 */

import { describe, it, expect } from "vitest";

import { scoreRun } from "./score.js";
import type { GroundTruth } from "./ground-truth.js";
import type { RunResult } from "./runner.js";

/**
 * Build a realistic successful RunResult carrying the three returned
 * arrays. Only kw1/kw2/kw3 and modelId feed scoreRun, but every field of
 * the RunResult contract is populated so the object is a genuine instance.
 */
function makeRun(
  modelId: string,
  kw1: string[],
  kw2: string[],
  kw3: string[],
): RunResult {
  return {
    modelId,
    ok: true,
    kw1,
    kw2,
    kw3,
    inputTokens: 1234,
    outputTokens: 56,
    reasoningTokens: 0,
    latencyMs: 842.5,
    providerFinishReason: "stop",
    rawResponse: JSON.stringify({ kw1_functions: kw1, kw2_functions: kw2, kw3_functions: kw3 }),
    schemaCompliant: true,
  };
}

/**
 * Build a GroundTruth whose three keyword buckets are the given expected
 * arrays. allFunctions defaults to the union of the three buckets (sorted),
 * which is what scoreRun consults for hallucination detection; callers can
 * override it to inject extra real functions or to omit some.
 */
function makeTruth(
  kw1: string[],
  kw2: string[],
  kw3: string[],
  allFunctions?: string[],
): GroundTruth {
  const union = [...new Set([...kw1, ...kw2, ...kw3])].sort();
  return {
    keywords: ["JSON.parse(", "new URLSearchParams", "performance.now()"],
    keywordFunctions: [kw1, kw2, kw3],
    noiseFunctions: [],
    allFunctions: allFunctions ?? union,
    fixtures: [],
  };
}

describe("scoreRun", () => {
  it("gives a perfect run max score: precision=recall=f1=1, meanF1=1, pass=true, no hallucinations", () => {
    const truth = makeTruth(["parseA", "parseB"], ["paramsC"], ["timerD"]);
    // Returned arrays exactly equal every expected set.
    const run = makeRun("good/model", ["parseA", "parseB"], ["paramsC"], ["timerD"]);

    const score = scoreRun(run, truth);

    expect(score.modelId).toBe("good/model");
    expect(score.pass).toBe(true);
    expect(score.meanF1).toBe(1);
    expect(score.hallucinated).toEqual([]);

    for (const pk of score.perKeyword) {
      expect(pk.precision).toBe(1);
      expect(pk.recall).toBe(1);
      expect(pk.f1).toBe(1);
      expect(pk.exactMatch).toBe(true);
      expect(pk.falsePositives).toEqual([]);
      expect(pk.falseNegatives).toEqual([]);
    }
    // truePositives are sorted; bucket 0 had two matches.
    expect(score.perKeyword[0].truePositives).toEqual(["parseA", "parseB"]);
  });

  it("computes precision/recall/f1=0.5 for a one-hit one-miss one-extra bucket", () => {
    // Expected {a,b}; returned {a,c}: tp=a, fp=c, fn=b.
    // precision = 1/(1+1) = 0.5, recall = 1/(1+1) = 0.5, f1 = 2*.5*.5/1 = 0.5.
    const truth = makeTruth(["a", "b"], [], []);
    const run = makeRun("partial/model", ["a", "c"], [], []);

    const score = scoreRun(run, truth);

    const pk = score.perKeyword[0];
    expect(pk.truePositives).toEqual(["a"]);
    expect(pk.falsePositives).toEqual(["c"]);
    expect(pk.falseNegatives).toEqual(["b"]);
    expect(pk.precision).toBe(0.5);
    expect(pk.recall).toBe(0.5);
    expect(pk.f1).toBe(0.5);
    expect(pk.exactMatch).toBe(false);
    // The other two buckets are empty-vs-empty: precision=recall=f1=1, exact.
    expect(score.perKeyword[1].f1).toBe(1);
    expect(score.perKeyword[2].f1).toBe(1);
    // meanF1 = (0.5 + 1 + 1) / 3 = 2.5/3.
    expect(score.meanF1).toBeCloseTo(2.5 / 3, 12);
    expect(score.pass).toBe(false);
  });

  it("scores a zero-overlap run: precision=recall=f1=0 for the mismatched bucket", () => {
    // Expected {a,b}; returned {x,y}: tp=0, fp=2, fn=2.
    // precision = 0/2 = 0, recall = 0/2 = 0, f1 = 0 (precision+recall===0).
    // x and y are not real functions (allFunctions = {a,b}), so both hallucinate.
    const truth = makeTruth(["a", "b"], [], []);
    const run = makeRun("zero/model", ["x", "y"], [], []);

    const score = scoreRun(run, truth);

    const pk = score.perKeyword[0];
    expect(pk.truePositives).toEqual([]);
    expect(pk.falsePositives).toEqual(["x", "y"]);
    expect(pk.falseNegatives).toEqual(["a", "b"]);
    expect(pk.precision).toBe(0);
    expect(pk.recall).toBe(0);
    expect(pk.f1).toBe(0);
    expect(pk.exactMatch).toBe(false);
    // meanF1 = (0 + 1 + 1)/3 over the empty-vs-empty buckets.
    expect(score.meanF1).toBeCloseTo(2 / 3, 12);
    expect(score.hallucinated).toEqual(["x", "y"]);
    expect(score.pass).toBe(false);
  });

  it("handles the empty-result boundary: returning nothing for a non-empty set gives precision=1, recall=0, f1=0", () => {
    // The 'nothing returned' quirk: tp=0, fp=0 -> precision branch returns 1
    // (tp+fp===0). recall = 0/(0+fn) = 0. f1 = 2*1*0/1 = 0. exactMatch=false.
    const truth = makeTruth(["a", "b", "c"], ["d"], ["e"]);
    const run = makeRun("empty/model", [], [], []);

    const score = scoreRun(run, truth);

    const pk = score.perKeyword[0];
    expect(pk.returned).toEqual([]);
    expect(pk.truePositives).toEqual([]);
    expect(pk.falsePositives).toEqual([]);
    expect(pk.falseNegatives).toEqual(["a", "b", "c"]);
    expect(pk.precision).toBe(1); // tp+fp===0 short-circuit
    expect(pk.recall).toBe(0);
    expect(pk.f1).toBe(0);
    expect(pk.exactMatch).toBe(false);
    // Every bucket missed everything -> all f1=0 -> meanF1=0, pass=false.
    expect(score.meanF1).toBe(0);
    expect(score.pass).toBe(false);
    expect(score.hallucinated).toEqual([]);
  });

  it("treats fully-empty truth-and-result as a perfect, passing match (precision=recall=f1=1)", () => {
    // All-correct boundary where the correct answer is 'nothing in any bucket'.
    // tp=fp=fn=0 -> precision=1, recall=1, f1=2*1*1/2=1, exactMatch=true.
    const truth = makeTruth([], [], []);
    const run = makeRun("empty-truth/model", [], [], []);

    const score = scoreRun(run, truth);

    for (const pk of score.perKeyword) {
      expect(pk.expected).toEqual([]);
      expect(pk.returned).toEqual([]);
      expect(pk.precision).toBe(1);
      expect(pk.recall).toBe(1);
      expect(pk.f1).toBe(1);
      expect(pk.exactMatch).toBe(true);
    }
    expect(score.pass).toBe(true);
    expect(score.meanF1).toBe(1);
    expect(score.hallucinated).toEqual([]);
  });

  it("computes asymmetric precision/recall for an all-correct-but-incomplete bucket (recall < precision)", () => {
    // Expected {a,b,c,d}; returned {a,b}: tp=2, fp=0, fn=2.
    // precision = 2/2 = 1 (no false positives), recall = 2/4 = 0.5,
    // f1 = 2*1*0.5/1.5 = 1/1.5 = 0.6666...
    const truth = makeTruth(["a", "b", "c", "d"], [], []);
    const run = makeRun("half-recall/model", ["a", "b"], [], []);

    const score = scoreRun(run, truth);

    const pk = score.perKeyword[0];
    expect(pk.truePositives).toEqual(["a", "b"]);
    expect(pk.falsePositives).toEqual([]);
    expect(pk.falseNegatives).toEqual(["c", "d"]);
    expect(pk.precision).toBe(1);
    expect(pk.recall).toBe(0.5);
    expect(pk.f1).toBeCloseTo(2 / 3, 12);
    expect(pk.exactMatch).toBe(false);
    // meanF1 = (2/3 + 1 + 1)/3 = (8/3)/3 = 8/9.
    expect(score.meanF1).toBeCloseTo(8 / 9, 12);
    expect(score.pass).toBe(false);
  });

  it("collects hallucinated names across all buckets, de-duplicated and sorted, using allFunctions as the real set", () => {
    // Real functions include extras not in any expected bucket so we can
    // distinguish 'real but wrong-bucket' from 'hallucinated' (not real).
    // realExtra is a genuine function (in allFunctions) returned in the
    // wrong bucket -> a false positive but NOT a hallucination.
    const truth = makeTruth(
      ["a"],
      ["b"],
      ["c"],
      ["a", "b", "c", "realExtra"], // allFunctions: 4 real names
    );
    // kw1: a (correct) + ghostZ (hallucinated, repeated to test dedupe)
    // kw2: b (correct) + ghostA (hallucinated) + realExtra (real, wrong bucket)
    // kw3: c (correct) + ghostZ again (dedupe across buckets)
    const run = makeRun(
      "halluc/model",
      ["a", "ghostZ"],
      ["b", "ghostA", "realExtra"],
      ["c", "ghostZ"],
    );

    const score = scoreRun(run, truth);

    // ghostZ appears twice and in two buckets -> one entry; sorted before nothing
    // alpha-wise ghostA < ghostZ. realExtra is real, so it is NOT hallucinated.
    expect(score.hallucinated).toEqual(["ghostA", "ghostZ"]);
    // realExtra shows up as a false positive in bucket 1, proving it was seen
    // as wrong-but-real rather than dropped.
    expect(score.perKeyword[1].falsePositives).toEqual(["ghostA", "realExtra"]);
    // bucket 0 had one true positive (a) and one false positive (ghostZ).
    expect(score.perKeyword[0].truePositives).toEqual(["a"]);
    expect(score.perKeyword[0].falsePositives).toEqual(["ghostZ"]);
    expect(score.pass).toBe(false);
  });
});
